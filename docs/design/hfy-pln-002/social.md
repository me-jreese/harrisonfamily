# HFY-PLN-002 design: social layer

Domain: social. Requirements: R-01, R-02, R-10, R-11, R-12, R-13, R-25, R-26, R-27, R-28, R-32.
Code read at harrisonfamily `c712e68` (`~/e0/wt/hfy-main-read`) and io-kit `31f6fb3` (`~/e0/wt/iokit-main-read`). Every `file:line` below refers to those trees. No real names, dates or contact details appear here. Where an example needs an id, it is written as `<gramps_id>` or `<ulid>`.

## 0. Requirement trace

| Req | io's intent (short) | Where in this design | Tasks |
| --- | --- | --- | --- |
| R-01 | Comments can carry photos | §9 | kit-comments-photos-order, hfy-comments-photos-desc-api, hfy-comment-photos-ui |
| R-02 | Admin graduates a comment photo into a record photo | §10 | hfy-graduate-api, hfy-graduate-ui |
| R-10 | Admins are notified of proposals | §5 (`proposal_submitted`) | hfy-inbox-delivery-api, hfy-proposal-notify-contrib |
| R-11 | Users are notified of accepted proposals and of updates to their own record | §5 (`proposal_accepted`, `record_updated_mine`) | hfy-proposal-notify-contrib, hfy-record-change-fanout |
| R-12 | Subscribe to any record and get notified when it changes | §6 | hfy-record-subs-api, hfy-follow-ui, hfy-record-change-fanout |
| R-13 | In-app notifications, unread list, mark read single and bulk, best UX on every device | §4 | kit-notify-inbox-server, kit-notify-inbox-react, hfy-inbox-delivery-api, hfy-inbox-ui |
| R-25 | Feed line "X contributions in the past Y ZZZZ", dynamic on volume and trend | §7.4 | hfy-contrib-ledger, hfy-contrib-read-api, hfy-feed-contrib-line |
| R-26 | Each record shows how many contributions that person made | §7.5, §8 | hfy-contrib-read-api, hfy-person-contrib-ui |
| R-27 | A contributions feed on each person page, right of comments 50/50 on wide screens, stacked below on small ones | §8 | hfy-person-sections-capped, hfy-person-contrib-ui |
| R-28 | Height-capped stories, comments and contributions with "older …" pagination | §8 | hfy-comments-photos-desc-api, hfy-person-sections-capped |
| R-32 | Admin moderation: hide, and ask the author for changes or a question by notification | §11 | kit-comments-moderation, kit-content-moderation, hfy-moderation-api-core, hfy-moderation-ask-api, hfy-moderation-ui, hfy-moderation-queue-page, hfy-moderation-record-targets |

## 1. The problem, grounded in the code

1. **Notifications are push only, and nothing is stored.** `createNotifier` returns before any work when VAPID is not configured (`api/src/notify.js:26-29`, `:37`). The handler skips the comment producer outright without push (`api/src/handler.js:13`, `:48`). io-kit `@io-kit/notify` 0.4.0 has no notification record, no unread state and no inbox route. Its handler serves only `vapid-public-key`, `subscribe` and `preferences` (`packages/notify/src/server.ts:290-325`). Its `HttpEvent` has no query string (`server.ts:246-249`). Its DynamoDB command bag has only Put, Delete and Query (`server.ts:43-47`). `buildDeclarativePush` accepts `appBadge`, but nothing computes it (`server.ts:195-212`). The `notifyV2` flag name is already in use for push and settings (`islands/src/islands/shell.jsx:172-179`).
2. **No producer exists for proposals, record changes or moderation.** The registry has four types (`api/src/notify.js:5-15`), mirrored by hand in the islands catalog (`islands/src/islands/notifications.jsx:13-23`).
3. **The API cannot keep counters atomically.** `transact()` builds only Put and Delete items (`api/src/txn.js:32-38`). The command bag has no UpdateCommand (`api/src/index.js:17`). The IAM role lacks `dynamodb:ConditionCheckItem` (`infrastructure/cloudformation/app-stack.yaml:88-90`), which a transactional ConditionCheck requires. Every `TransactionCanceledException` becomes a 409 "changed concurrently" (`api/src/comments.js:79`, `api/src/content.js:124`), including a benign `TransactionConflict` on a shared counter.
4. **Comments come back oldest first.** The query has no `ScanIndexForward:false` (`api/src/comments.js:98-101`), and the route summary says "oldest first" (`api/src/routes.js:63`). The UI button reads "show older comments" (`islands/src/lib/comments-ui.jsx:30`), but the kit appends the next page (`packages/comments/src/use-thread.ts:106-116`), so the button actually loads newer comments. The kit Thread puts the composer below the list and has no order option (`packages/comments/src/react.tsx:344-418`).
5. **Comments cannot carry photos.** The kit model has `Attachment {id,url,kind}` and `CreateInput.attachmentIds` (`packages/comments/src/model.ts:12-16`, `:71-80`), but the Composer has no picker or upload slot (`react.tsx:102-169`). The HFY source drops attachments on create (`islands/src/lib/comment-source.js:39-43`), and the API stores none (`api/src/comments.js:121-125`). The upload IAM grant covers `uploads/posts/*` only (`app-stack.yaml:96-100`).
6. **Moderation is delete-only.** The comments ModerationMenu is an admin delete with a reason (`react.tsx:224-247`). In content, admins may delete but cannot hide (`packages/content/src/policy.ts:9-27`). No moderation state exists. No admin flag reaches the client: the island guesses moderator rights from `can.delete` on someone else's comment (`comments-ui.jsx:141-146`), which fails on an empty thread. `config/admins.json` is empty until io names moderators (HFY-R70, HFY-R73).
7. **The person page has no social column and no caps.** Sections are hero, life, family, photos, stories, with the comments host last (`11ty/js/person-page.js:20-26`, `:291-310`; `islands/src/islands/person.jsx:44`). Tests pin "comments host last" (`islands/tests/person-page.spec.mjs:86-90`). Posts about a person are shown only to that person (`islands/src/islands/my-posts.jsx:91`).
8. **Production data is near empty.** There are 0 posts and 1 comment (digest, on-this-day fill §4). Pagination, caps and the contribution line are therefore designed against fixtures, and the empty start is a first-class state.

## 2. Design overview

```
                         ┌───────────────────────── hfy-api (one Lambda) ─────────────────────────┐
 comments/posts writes ─►│ comments.js / content.js ──commit()──► transact v2 (Put/Delete/Update/Check)│
 proposals (other dom.) ►│     │ contribOps()/revokeOps()  (same transaction)  ──► CONTRIB#, CSTAT#   │
 record store (other) ──►│     ▼ after commit                                                       │
 moderation route ──────►│ notifier (HFY registry) ──► kit createDelivery ──► NotificationStore     │
 graduation route ──────►│                              (persist first)       INBOX#<p> N#/U#/COUNT │
                         │                              └─► web push (only if VAPID + prefs)        │
                         └──────────────────────────────────────────────────────────────────────────┘
 islands: bell + panel/sheet (inboxV1) · follow (recordSubsV1) · person social row (contribV1)
          · comment photos (commentPhotosV1) · moderation menus/queue (moderationV1) · graduate (graduateV1)
```

The design follows six principles.

- **Persist first, push second.** Every notification becomes an inbox item before any push is attempted. Push is a per-type, per-device channel on top of the inbox.
- **One transaction per fact.** A contribution's event and counters, a moderation state and its audit item, and an inbox item and its unread counter are each written in the same `TransactWriteItems` call as the change that causes them.
- **The server computes capabilities** (HFY-R17). `can.moderate` is computed per item, and `GET /api/me` reports admin status for global UI. The client only reads them.
- **Kit first, then install.** The inbox lands in `@io-kit/notify`, photos and order in `@io-kit/comments`, and moderation in `@io-kit/comments` and `@io-kit/content`. harrisonfamily pins exact versions, which also fixes the `^` ranges in `api/package.json`.
- **Default-off flags per surface** (HFY-R8, HFY-R42). The server side is always on after deploy and does no harm with the UI off.
- **Privacy by construction.** Contribution events copy no body text. Comment photos are re-encoded in the browser, which bakes in orientation and strips EXIF, including GPS. Moderation reasons never leave the server.

## 3. Shared foundations

### 3.1 `transact()` v2 (Update, ConditionCheck, conflict retry)

`api/src/txn.js` keeps its signature and gains two members:

```js
transact(ddb, cmds, table, {
  puts = [],      // { item, condition?, names?, values? }                    (unchanged)
  deletes = [],   // key | { key, condition?, names?, values? }               (unchanged)
  updates = [],   // { key, update, condition?, names?, values? }  -> TransactItems Update
  checks = [],    // { key, condition, names?, values? }           -> TransactItems ConditionCheck
}, { retries = 3, token = uid() } = {})
```

- **Idempotency.** `ClientRequestToken` is set once per logical transaction and reused on every retry. If a retry follows a lost response, DynamoDB recognises the token and does not apply the change twice.
- **Retry policy.** On `TransactionCanceledException`, read `CancellationReasons`. Retry with jittered backoff (20, 60 and 150 ms) only when every reason other than `None` is `TransactionConflict`. Otherwise throw `TxnCancelled { reasons: Code[], failedIndex }`. Callers map a condition failure to their existing 409 and an exhausted retry to `503 busy`. Today's `comments.js:79` and `content.js:124` mappings change to this distinction.
- **Helpers.**
  - `counterUpdate(key, { n, ...namedDeltas }, { ttl })` produces `ADD #n :d, ... SET #ttl = if_not_exists(#ttl, :ttl)`.
  - `mergeUpdates(updates)` sums ADD deltas that target the same key, because one transaction may not touch an item twice.
  - `assertTxnSize(items)` keeps a transaction at 100 items or fewer.
- **Command bag.** `api/src/index.js:3,17` adds `UpdateCommand`.
- **Test fake.** `api/test/fake-ddb.js` adds:
  - `UpdateCommand` with `SET`, `SET if_not_exists`, `ADD` and `REMOVE`;
  - `ConditionCheck` inside a transaction;
  - `CancellationReasons`;
  - `Select:"COUNT"` and `SK BETWEEN` / `SK <` key conditions;
  - an injectable `failNext("TransactionConflict", n)`.
- **IAM** (`app-stack.yaml`, hfy-api role):
  - `Table` statement: add `dynamodb:ConditionCheckItem`.
  - New `CommentPhotoUploads`: `s3:PutObject` on `${MediaBucket}/uploads/comments/*`.
  - New `UploadReads`: `s3:GetObject` on `${MediaBucket}/uploads/comments/*` and `${MediaBucket}/uploads/posts/*`. This covers HEAD verification and the CopyObject source for graduation.
  - The graduation copy target is granted by the graduation task (§10). An app-stack change set needs io's go-ahead (AGENTS.md).

### 3.2 Admin exposure to the client

- `GET /api/me` (new route `me.get`) returns `{ id, label, admin, can: { moderate, graduate, approve } }`. The values come from the same `actor.admin` the API already computes from `config/admins.json` (`api/src/auth.js:45-48`). The response is `no-store`. The client uses it only to decide which controls to show, and every write re-checks on the server.
- Per-item `can.moderate` (content and comments kits, §11.4) is true only when the viewer is an admin and is not the author.
- `/auth/session` is not changed. The edge stays free of moderator semantics, and the website admin list stays the one source of truth for website moderation.
- `hfy-admin` (`config/groups.json`) keeps its MCP-only meaning: deletes under step-up (`api/src/policy.js:28-35`).
- `comments-ui.jsx:141-146` stops inferring admin status from `can.delete`. It reads `/api/me` instead.

### 3.3 Flags

These flags are added to `11ty/_data/flags.json` and all start as `false`. The loader is in `11ty/js/feature-flags.js:762-829`, and the preview override `?hfy_flags=` applies (HFY-R42).

| Flag | Gates | Implies | Server behaviour while the flag is off |
| --- | --- | --- | --- |
| `inboxV1` | Bell, panel or sheet, `/me/inbox/` page, app-badge sync | — | Inbox items are written and the routes answer. Nobody sees them. |
| `recordSubsV1` | Follow toggle on person pages, "pages you follow" list in settings | — | Routes answer. No follows exist until the UI ships. |
| `commentPhotosV1` | Photo picker in the comment composer. Browser normalization for post photos too (§9.3) | — | The API accepts attachments, but only callers that know the contract send them. |
| `contribV1` | Person social row (comments with contributions), height caps and "older" pagination, newest-first comments, hero count, feed line | — | Ledger and counters are written from deploy. The read routes answer. |
| `moderationV1` | Moderate menus, ask form, hidden badges and author banners, `/me/moderation/` | — | The route is live for admins. Hidden state is enforced regardless of the flag. |
| `graduateV1` | "Add to a family page" on comment photos | `commentPhotosV1`, `moderationV1` | The route is live for admins. |

The implication follows the HFY-R48 pattern: `graduateV1` forces its prerequisites on unless one is turned off explicitly with `-name`. `notifyV2` keeps its meaning.

## 4. Notifications v2: the inbox (R-13)

### 4.1 `@io-kit/notify` 0.5.0, server and contract (kit task `kit-notify-inbox-server`)

**Store contract** (`src/server.ts`, new section "inbox"):

```ts
export interface InboxInput { type: string; fields?: Record<string, unknown>; detail?: string; navigate: string; group?: string }
export interface InboxRecord { id: string; type: string; fields: Record<string,string>; detail?: string; navigate: string;
  group?: string; count: number; created_at: string; updated_at: string; read_at?: string }
export interface NotificationStore {
  add(principal: string, input: InboxInput): Promise<{ id: string; unread: number; coalesced: boolean }>;
  list(principal: string, o?: { filter?: "unread" | "all"; cursor?: string; limit?: number }): Promise<{ items: InboxRecord[]; next_cursor: string | null; has_more: boolean }>;
  unreadCount(principal: string): Promise<number>;
  markRead(principal: string, ids: string[]): Promise<{ updated: number; unread: number }>;
  markAllRead(principal: string, o?: { before?: string }): Promise<{ updated: number; unread: number; more: boolean }>;
}
export class InMemoryNotificationStore implements NotificationStore { /* tests and conformance */ }
export class DynamoNotificationStore implements NotificationStore {
  constructor(client, commands /* Get, Put, Delete, Query, Update, TransactWrite */, table, o?: { prefix?: "INBOX#"; unreadTtlDays?: 365; readTtlDays?: 90; now?; ulid? })
}
```

The `DynamoNotificationStore` layout uses PK and SK only, so the kit stays independent of the table's index names:

| PK | SK | Item | Notes |
| --- | --- | --- | --- |
| `INBOX#<principal>` | `N#<ulid>` | Full record `{entity:"notif", id, type, fields, detail?, navigate, group?, count, created_at, updated_at, read_at?, ttl}` | `ttl` is created + 365 d while unread and read_at + 90 d once read |
| `INBOX#<principal>` | `U#<ulid>` | Unread copy, same attributes, no `read_at` | Exists if and only if the item is unread. The unread list is one strongly consistent Query. |
| `INBOX#<principal>` | `COUNT` | `{unread, checked_at}` | Atomic `ADD`. No TTL. |
| `INBOX#<principal>` | `G#<group>` | `{nid, count, ttl}` | Coalescing pointer to the current unread item of a group |

How each operation works:

- **`add` without a group.** One transaction: `Put N#` (condition `attribute_not_exists(PK)`), `Put U#`, `Update COUNT ADD unread :1`. The returned `unread` comes from a consistent `GetItem COUNT` after the commit, because TransactWrite returns no values.
- **`add` with a group.**
  1. Read `G#<group>` with a consistent read.
  2. If it points at an item that is still unread, run one transaction: `Delete U#old` (condition: exists), `Delete N#old`, `Put N#new {count: old+1, created_at: old.created_at}`, `Put U#new`, `Put G#` (condition `nid = :old`). The unread count does not change, and the item moves to the top of the list.
  3. If the transaction is cancelled because the old item was read concurrently, fall back to a plain `add` plus `Put G#`.
- **`list`.** Query `begins_with(SK, "U#")` for unread or `"N#"` for all, with `ScanIndexForward:false`. The cursor is `u.<ulid>` or `a.<ulid>`. The page is read as `SK < <prefix><ulid>`, so the cursor row is never repeated. Limit 1–50, default 20. Returns the feed.v1 page shape `{items, next_cursor, has_more}`, so `@io-kit/feed` can page it.
- **`markRead(ids ≤ 100)`.** Chunks of at most 33 ids. Each chunk is one transaction: `Delete U#id` (condition: exists) and `Update N#id SET read_at, ttl` for each id, then `Update COUNT ADD unread :-k`. A cancellation caused by a missing `U#` (the item was already read) re-runs the chunk with only the ids whose `U#` still exists. The operation is idempotent: marking an item read twice returns `updated:0`.
- **`markAllRead`.** Pages `U#` items up to 500 per call and marks them in chunks. Returns `more:true` when it stopped at the cap. `before` limits the operation to items older than a given id, so items that arrived while the panel was open stay unread.
- **`unreadCount`.** A consistent `Get COUNT`. When the count is negative, missing while `U#` items exist, or `checked_at` is more than 24 h old, recount with `Query U# Select:COUNT` and `Put COUNT`. This repairs drift from TTL removal of unread items or from a partial failure. The returned value is never below 0.

**Templates.** `FeatureTemplates` (`server.ts:137-143`) gains three optional members:

- `inbox?: boolean` (default `true`). `false` makes a type push-only.
- `inboxText?: string`, the in-app body. It defaults to `level1`, then `level0`. The inbox is rendered at detail 1, because it lives inside the signed-in app and not on a lock screen.
- `many?: string`, the body used when `count > 1`, with `{count}` available.

`renderInbox(registry, record)` renders the title and body with the existing whitelist and the 80-character field cap (`server.ts:132,152-155`). `detail` holds free text of up to 1000 characters, such as a moderator's note. It is sanitised to plain text, never sent in a push and never rendered as markdown.

**Delivery** (new `createDelivery`):

```ts
export function createDelivery(deps: { registry; store?: NotificationStore; preferences: PreferencesStore;
  subscriptions?: SubscriptionStore; webpush?: WebPushLike; vapid?: VapidDetails; log?; concurrency?: number /* 8 */ })
  : (i: { feature; recipients: string[]; exclude?: string[]; navigate; fields?; detail?; group? }) =>
      Promise<{ stored: number; pushed: number; failed: number }>
```

For each unique recipient that is not excluded, with bounded concurrency:

1. If the type is stored in the inbox, call `store.add`. A failure is logged as `inbox_failed`, counted, and not thrown.
2. If `webpush`, `vapid` and `subscriptions` are all present, call `buildDeclarativePush` with the recipient's prefs and `appBadge` set to the unread count returned by `add`, then `sendToPrincipal`. Expired subscriptions are still dropped on 404 or 410 (`server.ts:236-239`).

Delivery never throws. Without VAPID it still stores, which is how notifications persist when push is off.

**Handler.** `createNotifyHandler` (`server.ts:290`) accepts `inbox?: NotificationStore`, `registry?: TemplateRegistry` and `HttpEvent.queryStringParameters`. When `inbox` is set it serves:

- `GET {base}/notifications/inbox?filter=unread|all&cursor=&limit=` returns an `InboxPage` whose items are rendered `InboxItem`s.
- `GET {base}/notifications/inbox/unread-count` returns `{unread}`.
- `POST {base}/notifications/inbox/read` takes `{ids:[1..100]}` or `{all:true, before?}` and returns `{updated, unread}`.

Errors are `400 {error:"invalid mark-read"}`, `400 {error:"cursor_invalid"}` and `401`.

**Schema and fixtures.** `schema/notify.schema.json` adds the `$defs` `InboxItem {id,type,title,body,detail?,navigate,created_at,updated_at,read,count}`, `InboxPage`, `UnreadCount`, `MarkReadRequest` (oneOf ids or all) and `MarkReadResponse`. Fixtures: `inbox-page.json`, `unread-count.json`, `mark-read-ids.json`, `mark-read-all.json`, `invalid-mark-read-empty.json`.

**Conformance.** `@io-kit/notify/testing` adds `runInboxStoreSuite(make)`, cases NI-01 to NI-12:

- add raises unread;
- list returns newest first;
- the unread filter works;
- cursors are stable across inserts;
- markRead is idempotent;
- markAll respects `before`;
- coalescing keeps one unread item and increments `count`;
- the read TTL is set;
- the count reconciles after injected drift;
- two concurrent adds both count;
- `detail` is capped;
- `navigate` must be a same-origin path (it starts with `/` and not `//`).

Both the in-memory store and the Dynamo store (over a fake document client) must pass.

### 4.2 `@io-kit/notify` 0.6.0, client and React (kit task `kit-notify-inbox-react`)

- **`NotifyApi`** (`client.ts:6-12`) gains the optional methods `listInbox(o)`, `unreadCount()`, `markRead(ids)` and `markAllRead(before?)`, implemented in `createFetchNotifyApi` (`client.ts:84-103`). It also gains `syncAppBadge(n)`, which calls `setAppBadge(n)`, or `clearAppBadge()` when `n` is 0, and swallows errors, as `clearBadge` already does (`client.ts:77-82`).
- **`useInbox({ api, pollMs = 60000, pageSize = 20, filter })`** returns `{ items, unread, status, error, hasMore, loadMore, markRead, markAllRead, refresh, setFilter }`.
  - It polls the unread count only while `document.visibilityState === "visible"`, and immediately on `visibilitychange`.
  - It refreshes on a service-worker message `{type:"iok-notify:push"}`.
  - It syncs tabs through `BroadcastChannel("iok-notify")`.
  - Reads are optimistic and roll back on failure.
  - It calls `syncAppBadge` whenever `unread` changes.
  - An optional `subscribe(onSignal)` seam accepts a signal-then-fetch transport later (L-09), for example the chat domain's realtime channel.
- **`NotificationBell({ unread, onClick, expanded, controls, labels })`** is one `<button>` with `aria-label="notifications, 3 unread"`, `aria-expanded` and `aria-controls`. The badge text is 1–9, or `9+` above that. A polite live region announces an increase only, never a decrease.
- **`NotificationInbox({ inbox, labels, formatTime, onOpen, renderItem? })`** has:
  - a header with the title, an unread/all segmented control and "mark all read";
  - list items with an unread dot, title, body, a ×N count, time and `detail` clamped to 3 lines with "more", plus a per-item 44 px "mark read" button;
  - empty, error-with-retry and "show older" states;
  - `onOpen(item)`, which marks the item read, then the host navigates.
- **Service worker.** `sw/notify-sw.js:5-17` also posts `{type:"iok-notify:push"}` to all clients in the `push` handler.
- **Styles.** `notify.css` adds `--io-notify-inbox-*` tokens: 44 px targets, 16 px text, no literal colours.

### 4.3 The harrisonfamily install (task `hfy-inbox-delivery-api`)

- **Pins.** `api/package.json` pins `@io-kit/notify` exactly at `0.5.0` (and later `0.6.0` in `hfy-inbox-ui`, so api and islands stay on one notify version).
- **Wiring.** `api/src/index.js` builds `new DynamoNotificationStore(ddb, cmds, table)` (default prefix `INBOX#`).
- **`api/src/notify.js`.**
  - `createNotifier` keeps its exported shape, but `notify()` becomes the kit `createDelivery`.
  - The `enabled()` guards at `:26-29` and `:37` are removed for inbox writes; push still needs VAPID.
  - `TEMPLATE_REGISTRY` gains the types in §5 and widens `whitelist` to `["actor","subject","item","count"]`.
- **`api/src/handler.js:48`** drops the `pushEnabled &&` gate, so comment notifications always run. The extra `commenterIds` Query per comment is acceptable at family scale.
- **Routes.** `ROUTES` (`api/src/routes.js:123-128`) adds `notifications.inbox.list`, `notifications.inbox.count` and `notifications.inbox.read`, all served through `c.notifyHandler()` with `inbox` and `registry` passed. It also adds `me.get` (§3.2). `buildCaps()` lists them. No `POLICY_ROWS` row is added, so MCP tools/list does not change.
- **`new_family_post`** is `inbox:false`. The timeline is its in-app surface, and storing it would create one unread item per member for every post.

### 4.4 UX by device and viewport (task `hfy-inbox-ui`)

**Placement.** A bell sits in the top bar's `.hfy-bar__end`, before `<Account/>` (`islands/src/islands/shell.jsx:199`). That bar shows at every width (frontend map), so the bell is reachable at 375 px without a bottom-bar slot. The compact bottom bar is capped at 5 primary items (registry.ts:23). The bell renders only for a signed-in edge session (`useEdgeSession`, `shell.jsx:104`) and only with `inboxV1`.

| Viewport | Container | Behaviour |
| --- | --- | --- |
| < 43rem (375 px phone, installed PWA) | Kit `Sheet side="bottom"`, title "notifications", height `min(85dvh, …)`, safe-area padding through `--io-shell-safe-*` | Full-width rows at least 56 px high. Tapping a row marks it read and navigates. The trailing 44 px check button marks one item read. "mark all read" is a text button in the sheet header. Unread/all are two 44 px segments. The sheet closes on navigation. There are no swipe gestures (simple beats clever). |
| 43rem – 64rem | Anchored panel (non-modal `role="dialog"`), right-aligned under the bell | Width `min(var(--io-layout-card), calc(100vw - 2 * var(--io-space-4)))`, max-height `calc(100dvh - var(--io-space-9) * 2)`, internal scroll. Escape, an outside click or a navigation closes it, and focus returns to the bell. |
| ≥ 64rem | Same anchored panel | The pointer gets hover affordances (`@media (hover:hover)`). The footer link "see all" goes to `/me/inbox/`. |
| Any width | `/me/inbox/`, a new repo-owned page with the same `NotificationInbox` | The page shows a "notification settings" link to `/me/notifications/`. Add it to `heads.mjs` PAGES, `copy.mjs` COPY_EXTRA, the README lists, `bundle.test.mjs:18` and the loader route regex. |

- Opening the panel does not mark anything read. Read state changes only on an explicit action, so a quick peek never loses an item.
- The app icon badge equals the unread count. It is set by the push payload (`app_badge`) and kept in step by `useInbox` through `syncAppBadge`.
- **Copy** follows the DS voice: lowercase, and "page", never "record".
  - Header: "notifications".
  - Empty: "you're all caught up."
  - Error: the existing `COPY.failed` line.
  - Load more: "show older".
  - Button: "mark all read".
- **Islands catalog.** `islands/src/islands/notifications.jsx:13-23` gains the new types for the settings toggles, grouped "about me", "family" and "for moderators". The moderators group is shown only when `/api/me` reports `admin`. A contract test fails when the islands CATALOG and the API registry differ in type ids or level 0 and level 1 strings.

## 5. Notification types and producers (R-10, R-11, R-12, moderation)

All types are stored in the inbox unless the table says push-only. `{item}` is one of `post`, `story`, `comment` or `photo`. The navigate targets are same-origin paths that the server generates.

| Type | Recipients | Producer (where it is called) | Group key | Level 0 / level 1 (push) | `detail` | Navigate |
| --- | --- | --- | --- | --- | --- | --- |
| `comment_on_my_record` (existing) | Record owner or post author | `notifier.onComment` (`notify.js:61-71`) | `thread:<t>` | unchanged; `many`: "{count} new comments on your page." | — | thread URL |
| `reply_to_me` (existing) | Parent author and earlier commenters | same | `thread:<t>` | unchanged | — | thread URL |
| `mention` (existing) | Mentioned principals | same | — | unchanged | — | thread URL |
| `new_family_post` (existing) | Every push subscriber (Scan, `notify.js:81-101`) | `onPublished` | — | unchanged; **push-only** | — | `/posts/?id=` |
| `proposal_submitted` (R-10) | Admins from `config/admins.json`, minus the proposer | `onProposalSubmitted`, called by the proposals domain after its commit | `proposals` | "someone suggested a change." / "{actor} suggested a change to {subject}'s page." | — | the proposals domain's review URL |
| `proposal_accepted` (R-11) | The proposer | `onProposalDecided` | — | "your suggested change was accepted." / "{actor} accepted your change to {subject}'s page." | — | `/person/?id=<subject>` |
| `proposal_declined` | The proposer | `onProposalDecided` | — | "your suggested change wasn't added." / "{actor} didn't add your change to {subject}'s page." | admin's note | `/person/?id=<subject>` |
| `record_updated_mine` (R-11) | The record's owner, when a member and not the actor | `onRecordChanged`, called by the records and sync domains | `rec:<subject>` | "your page was updated." / "{actor} updated your page." | — | `/person/?id=<owner>` |
| `record_updated_followed` (R-12) | Followers of the record (§6), not the actor | `onRecordChanged` | `rec:<subject>` | "a page you follow was updated." / "{subject}'s page was updated." | — | `/person/?id=<subject>` |
| `records_updated_followed_digest` | A follower who would get more than 3 followed updates from one batch | `onRecordChanged` (batch) | `recdigest` | "pages you follow were updated." / "{count} pages you follow were updated." | — | `/me/inbox/` |
| `moderation_hidden` (R-32) | The item's author | `onModeration` | — | "a moderator hid something you shared." / "{actor} hid your {item}." | — (the reason stays private) | item URL |
| `moderation_request` (R-32) | The item's author | `onModeration` | — | "a moderator asked you to update something you shared." / "{actor} asked you to update your {item}." | admin's note | item URL |
| `moderation_question` (R-32) | The item's author | `onModeration` | — | "a moderator has a question about something you shared." / "{actor} has a question about your {item}." | admin's note | item URL; plus "reply in chat" once the chat domain ships |
| `moderation_unhidden` | The item's author | `onModeration` | — | "something you shared is visible again." / "your {item} is visible again." | — | item URL |
| `moderation_resolved` | The admin who asked | `onModeration` (on author edit) | `mod:<target>` | "an item you asked about was updated." / "{actor} updated the {item} you asked about." | — | item URL |
| `photo_graduated` (R-02) | The photo's author | `onGraduated` | — | "your photo was added to a family page." / "{actor} added your photo to {subject}'s page." | — | `/person/?id=<subject>#photos` |

Producer rules:

- Every producer is post-commit: it runs inside `afterCommit` (`handler.js:15-21`), and it never fails the write. A producer called by another domain receives a plain object, so the caller passes data, not a closure over its own store.
- **`onRecordChanged(changes, { batchId, silent })`.**
  - `changes` is a list of `{ subject: "person:<gramps_id>", actor: {id,label}|null, source: "self_edit"|"proposal"|"admin_edit"|"gramps_sync"|"tag" }`.
  - `silent:true` is mandatory for imports, seeding and backfills, so the first cloud import never sends hundreds of notifications.
  - The owner is notified only when the owner is a member. Membership comes from the values of the S3 allowlist (`config/userGrampsID.json`), which the hfy-api role can already read through `config/*` (`app-stack.yaml:91-94`). It is cached for 5 minutes and is never logged.
  - Followers come from one GSI1 Query per changed subject.
  - Fan-out per call is bounded by the number of members, not records, because of the per-recipient digest and the coalescing groups.
- **`onProposalSubmitted` and `onProposalDecided`** take `{ proposal: {id, subject, proposer:{id,label}}, decision?, note?, by }`. Recipients for submissions come from `getAdmins()` (`auth.js:12-26`).
- Notification fields carry display labels only. HFY-R68 keeps them free of email addresses, and `sanitiseValue` caps them at 80 characters. The only free text is `detail`, which passes the shared contact-info validator from the privacy domain (R-18) when an admin writes it.

## 6. Record subscriptions, "follow" (R-12)

**Data.** One item serves both "my follows" and fan-out:

```
PK RSUB#<principal>   SK REC#person:<gramps_id>
   { entity:"rsub", subject:"person:<gramps_id>", created_at, GSI1PK:"RECSUB#person:<gramps_id>", GSI1SK:"<principal>" }
```

**Routes** (`api/src/routes.js`; none has an `mcp` member):

| Name | Method and path | Request | 200/201 | Errors |
| --- | --- | --- | --- | --- |
| `subscriptions.get` | `GET /subscriptions?subject=person:<id>` | — | `{subject, subscribed}` | 400 validation (bad subject) |
| `subscriptions.list` | `GET /subscriptions?cursor=&limit=` | — | `{items:[{subject, created_at}], cursor}` (mine, newest first) | 400 cursor_invalid |
| `subscriptions.put` | `PUT /subscriptions/person/:id` | `{}` (JSON body required by the 415 rule, `handler.js:86-87`) | `{subject, subscribed:true}`, idempotent | 404 not_found (no `person/<id>.json`, checked with the labels loader, `labels.js:13,41`); 400 `self_subscribe` |
| `subscriptions.remove` | `DELETE /subscriptions/person/:id` | — | 204, idempotent | — |

The delete route is named `subscriptions.remove` on purpose. A name ending in `.delete` would match the `*.delete` policy glob (`policy.js:34`), which reads as an admin step-up action.

**Policy defaults:**

- Following is explicit. There is no automatic follow of relatives.
- An owner is implicitly subscribed to their own page through `record_updated_mine`.
- Following someone does not tell the followed person.
- Follows are not audited, which matches today's rule for subscriptions and preferences (backend map).
- There is no cap at family scale. 231 records bound the list.

**UX** (task `hfy-follow-ui`, flag `recordSubsV1`):

- **Person hero.** A 44 px toggle next to the name reads "follow" or "following" (`aria-pressed`). It is absent on your own page and when signed out. On first use, a one-line helper under it says "we'll let you know when this page changes." A failure shows a banner, and the toggle rolls back.
- **At 375 px** the toggle drops below the name as a full-width secondary button. At 64rem and up it sits inline.
- **Settings.** `/me/notifications/` gains a "pages you follow" section listing names (resolved through the people corpus, `islands/src/lib/people-corpus.js`), each with a 44 px "unfollow" button and "show more" paging.

## 7. Contributions (R-25, R-26, R-27)

### 7.1 What counts

| Kind | Credited to | When | Weight | Notes |
| --- | --- | --- | --- | --- |
| `post` | Post author | First transition to `published` (create published, or draft → published) | 1 | Counted once per post (`post.contrib` set). Withdraw hides the event, and republishing unhides it with no new count. |
| `photo` | Post or comment author | With its post or comment | +1 per image (posts up to 4 in the HFY composer and 10 in the API; comments up to 4) | A post with 3 photos counts 4. |
| `comment` | Comment author | Create | 1 | Photo-only comments count 1, plus photos. |
| `proposal_accepted` | Proposer | Admin approval (proposals domain transaction) | 1 | One per proposal, however many fields it changed. |
| `self_edit` | The member | A committed own-record save (records domain transaction) | 1 | At most 1 per record per UTC day, enforced by marker item `CAP#…` (below). |
| `tag` | The tagger | Tag committed, or accepted when tags are proposals (tagging domain) | 1 | Per person-region tag. |
| `photo_to_record` | The **photo's author**, not the admin | Graduation finalize (§10) | 1 | Rewards the member whose photo became family record. |

The table also settles what does not count, and how deletes and MCP are handled:

- **Not counted:**
  - edits of posts or comments;
  - reactions;
  - follows;
  - moderation actions;
  - admin approvals (the approver is not credited);
  - Gramps desktop pushes (`via:"sync"`), which are maintenance, not member contribution.
- **Deletes revoke.** Deleting a post or comment, whether by its author, by a moderator, or by the cascade when a post is deleted (`comments.js:187-217`), removes the event and decrements every counter in the same transaction. The count then always means "contributions that exist on the site", and a post-and-delete loop cannot farm points. Hide and withdraw keep the count but hide the feed entry from other viewers.
- **MCP counts.** MCP tools run the same handlers as the member principal (BRD D-16). A comment created through MCP is a contribution and is tagged `via:"mcp"` on the event. An MCP post is draft-only (`routes.js:50-52`), so it counts only when a human publishes it in the UI.

### 7.2 Ledger data model and operation builders (task `hfy-contrib-ledger`)

```
Event   PK CONTRIB#<principal>        SK E#<ulid>
        { entity:"contrib", id, kind, actor:{id,label}, at, weight, photos, via:"ui"|"mcp",
          ref:{ type:"post"|"comment"|"proposal"|"record"|"tag"|"media", id, thread? }, subject?, hidden?,
          GSI1PK:"CONTRIBS", GSI1SK:"<ulid>" }
Cap     PK CONTRIB#<principal>        SK CAP#self_edit#<subject>#<YYYY-MM-DD>   { ttl: +2 d }
Site    PK CSTAT#site                 SK TOTAL            { n, n_post, n_comment, n_photo, n_self_edit, n_proposal_accepted, n_tag, n_photo_to_record, first_at }
        PK CSTAT#site                 SK D#<YYYY-MM-DD>   { n, ttl: day + 800 d }      (UTC days)
        PK CSTAT#site                 SK M#<YYYY-MM>      { n }
        PK CSTAT#site                 SK LINE             { x, y, unit, window_days, text, computed_at, ttl: +2 h }   (cache, §7.4)
Person  PK CSTAT#person:<principal>   SK TOTAL            { n, n_<kind>…, first_at }
        PK CSTAT#person:<principal>   SK M#<YYYY-MM>      { n }
Links   post.contrib = { id:<event ulid> }   comment.contrib = { id:<event ulid> }   (on the stored item)
```

`api/src/contrib.js` exports pure builders that return `{ puts, deletes, updates, checks }` fragments, which callers merge into their own `transact()` call:

- **`contribOps({ actor, kind, ref, subject, photos, at, via, uid })`** produces:
  - one event Put (condition `attribute_not_exists(PK)`);
  - five counter updates through `counterUpdate`: site TOTAL, site day, site month, person TOTAL and person month, using `SET first_at = if_not_exists(first_at, :at)`.

  Seven items in total.
- **`revokeOps(event)`** produces a Delete of the event (condition: exists) and the same five updates with negated deltas, placed in the buckets of `event.at`. A bucket past its TTL has already gone. Re-adding it with `if_not_exists` TTL gives a negative row that expires within days, and reads clamp at 0.
- **`hideOps(event, hidden)`** produces `Update SET hidden = :h` on the event. Counts do not change.
- **`mergeOps(...fragments)`** concatenates fragments, merges updates that share a key through `mergeUpdates`, and asserts 100 items or fewer. `purgeThread` (`comments.js:198-215`) uses it, because 30 comments by one author in one month must become one decrement per counter key, not 30 rejected duplicates. The purge batch size is recomputed with this in mind: up to 40 comments per transaction, each comment's own delete, audit and event delete, plus at most 5 merged counters per distinct author-month.

**Wiring** (inside the existing commit paths, in the same transaction as the write and its audit item):

| Write | File | Change |
| --- | --- | --- |
| Comment create | `api/src/comments.js:112-128` `commit()` | `+ contribOps(comment, photos k)`, and store `comment.contrib` |
| Comment delete | `comments.js:146-155` | `+ revokeOps` when `c.contrib` is set |
| Thread purge | `comments.js:187-217` | `+ mergeOps(revokeOps…)` per batch |
| Post create (published) or first publish | `api/src/content.js:161-185`, `:204-213` | `+ contribOps(post, photos k)`; set `post.contrib` |
| Withdraw / republish | `content.js:204-213` | `+ hideOps` |
| Post delete | `content.js:214-218` | `+ revokeOps` |
| Moderation hide/unhide | §11 | `+ hideOps` |
| Graduation finalize | §10 | `+ contribOps(photo_to_record, actor = photo author)` |
| Proposal accept, self-edit, tag | Other domains | They call `contribOps` in their own transaction (contract in §15). For `self_edit` the caller reads the `CAP#` marker first and skips counting when it exists. The marker Put has no condition, so a race can at worst count twice, which is benign. |

**MCP origin.** `handler.invoke` (`handler.js:64-68`) passes `via:"mcp"` into `build()`, so builders can stamp the event. HTTP calls stamp `via:"ui"`.

**Backfill.** `api/scripts/contrib-backfill.mjs --dry-run|--apply` scans `POST#…/META` and `THREAD#…/C#` items. It writes events with `at` taken from the item's `created_at` and the post's first publish (from AUDIT# `visibility` entries), then rebuilds every `CSTAT#` row from the events. It is idempotent, because event ids are derived as `ulid(created_at)` plus a hash of the ref. Production holds 1 comment today, so the run is trivial, but it must exist so that counts are true at the flip.

### 7.3 Concurrency

- Every contribution updates `CSTAT#site` rows, so two simultaneous writes can cancel each other with `TransactionConflict`. The `transact()` v2 retry (§3.1) absorbs this. A user sees an error only after 3 failed retries, as `503 busy` with the "that didn't post. it's still here" line, and the composer keeps the text.
- Expected volume is tens of writes per day, so a conflict is a rare edge, not a hot path.

### 7.4 The feed line, "X contributions in the past Y ZZZZ" (R-25)

**Input.** The site daily buckets `D#` for the last 800 days, the `M#` buckets for longer spans, and `TOTAL.first_at`. Days are UTC.

**Candidate windows**, in order: 1–6 days (unit `day`), 7, 14 and 21 days (`week`), 30, 60, 90 and 180 days (`month`), then 365, 730, … days (`year`). Windows longer than 400 days use `M#` buckets. A window is eligible only when the site's history (`first_at`) is at least as long as the window, so the line never claims "the past 2 years" for a younger site.

For window `w`:

- `X(w)` is the sum of the `w` most recent daily buckets, today included.
- `P(w)` is the sum of the `w` buckets immediately before those.

**Selection** (pure function `pickLine(buckets, today, firstAt)`):

1. **Hot.** Take the shortest window of 30 days or fewer with `X(w) ≥ 5` and `X(w) ≥ P(w)` (flat or rising). A burst of recent activity shows as a short window: "12 contributions in the past 3 days".
2. **Volume.** Otherwise take the shortest eligible window with `X(w) ≥ 3`. A quieter site gets a longer window that is still true: "9 contributions in the past 2 months".
3. **Fallback.** If no window reaches 3, return `null`. The UI then shows the no-number line "add a photo or a story to get things going." It never shows "1 contribution in the past day".

**Stability.** The line is cached in `CSTAT#site/LINE` and recomputed when it is more than 1 hour old. Within a UTC day, the cached pick is kept while it stays valid (`X ≥ 3`) and the new pick is within one candidate step of it, so reloads never flicker between neighbouring windows.

**Copy.** `${X} contribution${X===1?"":"s"} in the past ${y===1 ? unit : `${y} ${unit}s`}`, lowercase (DS voice).

**Tests.** A golden table of at least 12 cases: an empty site, a single burst, a steady trickle, a falling trend, a rising trend, a young site, a year-boundary span, a negative bucket that clamps to 0, and the dwell hysteresis.

**Where it shows** (task `hfy-feed-contrib-line`):

- under the "latest from the family" heading of the homepage timeline (`islands/src/islands/timeline.jsx:16-19`);
- under the `/posts/` `h1` (`islands/src/islands/posts.jsx:53`).

It renders as `p.hfy-contrib-line` in text.dim at 16 px. Signed out, nothing renders, as the timeline already behaves (`timeline.jsx:23-31`).

### 7.5 Read API (task `hfy-contrib-read-api`)

| Name | Method and path | 200 | Notes |
| --- | --- | --- | --- |
| `contributions.list` | `GET /contributions?author=<gramps_id>&cursor=&limit=` (limit 1–50, default 10) | `{items:[{id, kind, at, weight, photos, ref, subject?, href, hidden?}], cursor}` | Query `CONTRIB#<author>` with `begins_with E#`, descending. See the visibility rules below. |
| `contributions.stats` | `GET /contributions/stats?author=<gramps_id>` | `{author, total, by_kind:{post, comment, photo, self_edit, proposal_accepted, tag, photo_to_record}, first_at?}` | Values clamped at 0. An unknown author returns zeros, not 404. |
| `contributions.site` | `GET /contributions/stats` | `{total, line:{x,y,unit,window_days,text}\|null, computed_at}` | Uses and refreshes the LINE cache. |

**Visibility in `contributions.list`:**

- `hidden` events are returned only to the author and to admins.
- Events on `post:` threads and post events are batch-checked against the current post (`BatchGet POST#…/META`, at most 20) for `canView` plus moderation. Unprocessed keys are retried once, then the event is omitted. This fails closed.
- Events never copy body text, so a withdrawn thread leaks nothing.

`href` is computed by the server:

| Ref | `href` |
| --- | --- |
| post | `/posts/?id=` |
| person-thread comment | `/person/?id=<x>#comment-<ulid>` |
| proposal, record, tag | `/person/?id=<subject>` |
| media | `/person/?id=<subject>#photos` |

## 8. The person page: layout and pagination (R-26, R-27, R-28)

**Structure** with `contribV1` on. `person-page.js` keeps hero, life, family, photos and stories. The person island (`islands/src/islands/person.jsx:43-44`) mounts `#hfy-person-social` as the last child of `#person-content` in place of the bare comments host:

```
#person-content
  … hero (+ "42 contributions" chip, + follow toggle)   life   family   photos
  #person-stories-section   (notes from the record + published posts about this person, capped, "show older stories")
  #hfy-person-social  .hfy-social
     section#hfy-person-comments       (h2 "comments", composer on top, newest first, capped, "show older comments")
     section#hfy-person-contributions  (h2 "contributions" + total, newest first, capped, "show older contributions")
```

**Breakpoints** use DS tokens `bp.medium` 43rem and `bp.wide` 64rem (HFY-R72):

| Viewport | Social row | Caps (`max-height` of each list body) |
| --- | --- | --- |
| < 43rem (375 px) | Stacked: comments, then contributions, each full width. Their "older" buttons are full-width 44 px. | `--hfy-cap-section: calc(var(--io-space-9) * 7)` = 448 px. Stories use the same cap. |
| 43rem – 64rem | Stacked | `calc(var(--io-space-9) * 9)` = 576 px |
| ≥ 64rem | `display:grid; grid-template-columns: 1fr 1fr; gap: var(--io-space-7); align-items:start`. Comments on the left, contributions on the right, 50/50. | 576 px for both columns, so the two tops and caps line up. Each column expands on its own. |

The kit SplitPage switches at 960 px, which does not match the DS breakpoints (frontend map), so this layout is plain CSS grid and does not use SplitPage. All values are token expressions, as theme-lint requires.

**`CappedSection`** (new `islands/src/lib/capped.jsx`) is shared by stories, comments and contributions. It bounds both download and render, as io asked.

- **First page sizes:** stories 5 posts (record notes come with the person JSON and are only clipped), comments 8, contributions 10.
- **Clipping.** The list body has `max-height: var(--hfy-cap)` and `overflow:hidden`, with a fade mask while it overflows. A `ResizeObserver` measures the content. Items that start below the cap get `inert` and `aria-hidden="true"`, so keyboard and screen-reader users never land on clipped content.
- **"show older …"** first raises the cap by one step and moves focus to the first revealed item. Once nothing loaded remains hidden, it fetches the next page, then raises the cap. Sections grow in the page. There is no nested scroll box, which works badly on phones.
- **States.**
  - Loading: skeleton rows.
  - Error: a danger banner with retry.
  - Empty:
    - comments: "no comments yet."
    - contributions: "no contributions yet." On your own page an action follows: "add a photo".
    - stories: the existing `VOICE.noStories`.
  - The "older" button is hidden when everything is loaded and visible.

**Comments, newest first** (fixes the ordering bug):

- The API adds `order=desc` to `GET /comments` (§9.4).
- Kit comments 0.2.0 adds:
  - `ListOptions.order`;
  - a `useThread` order option, so with `desc` a new comment is prepended and `loadMore` appends older ones;
  - `Thread composerPosition="top"`;
  - a `renderMore({hasMore, loading, loadMore})` slot, so the host's `CappedSection` button drives paging.

  With `contribV1` off, the current Thread stays as it is. Its label changes from "show older comments" to "show more comments", which is true for oldest-first paging (`comments-ui.jsx:30`).
- **Anchors.** `#comment-<ulid>` in the URL scrolls to and highlights that comment, loading pages until found, up to 5. Inbox and contribution links rely on it.

**Stories.** The stories list shows published posts with `subject=<id>` to every signed-in viewer, not only the owner (`my-posts.jsx:91`). These posts are already visible on `/posts/` and on the timeline, so nothing new is exposed. The composer stays owner-only.

**Contributions column** (task `hfy-person-contrib-ui`):

- Each row is one 44 px+ link: a kind glyph (a currentColor mask icon) and a sentence, then the time through `lib/time.js`:
  - "shared a post with 3 photos"
  - "commented on {name}'s page"
  - "updated their page"
  - "had a change accepted on {name}'s page"
  - "tagged {name} in a photo"
  - "their photo was added to {name}'s page"
- `{name}` resolves from the people corpus, falling back to "a family page".
- The header shows the total ("42 contributions"). The hero chip "42 contributions" links to `#hfy-person-contributions` and is hidden at 0 (R-26).
- With `contribV1` on, the owner's own page shows hidden entries to them with a "hidden" tag.

**Tests to update:**

- `person-page.spec.mjs:72-90`: the last child becomes `#hfy-person-social` when the flag is on; the old assertion stays for flag off.
- `bundle.test.mjs:18`: add any new island files.
- New `person-social.spec.mjs`: at 1280 the two columns render at equal widths within 1 px; at 375 and 768 they stack; caps clip and inert hidden items; "show older" paging; newest-first order; an anchor deep link.

## 9. Photo comments (R-01)

### 9.1 Kit, `@io-kit/comments` 0.2.0 (task `kit-comments-photos-order`)

- **Model.** `Attachment` gains `mime?`, `width?`, `height?` and `alt?` (`model.ts:12-16`). `CreateInput` and `EditInput` gain `attachments?: NewAttachment[]` (`{url, mime, width?, height?, alt?}`). `attachmentIds` is kept for coach.
- **Composer** (`react.tsx:102-169`):
  - `onUpload?(file): Promise<NewAttachment>`, plus `accept`, `maxAttachments` (default 0, which means off) and `placeholder`. The placeholder prop closes the gap HFY patches by DOM mutation today (`comments-ui.jsx:37-45`).
  - A visible 44 px "add a photo" button. The native input is hidden and inert, which removes the DOM decoration HFY applies to PostComposer today (`my-posts.jsx:5-12`).
  - Per-photo rows: a 44 px thumbnail, an optional alt input with the placeholder "describe the photo", a "remove" button and an upload progress state.
  - Submit is allowed with no text when at least one photo is attached. `useThread.add` already permits this (`use-thread.ts:120`).
- **Rendering.** `Comment` renders attachments as `<a href={url} target="_blank" rel="noopener">` around `<img alt={alt ?? ""} loading="lazy" width height>`. The host can replace this with `renderAttachment`, and add per-attachment actions with `renderAttachmentActions(comment, attachment)` (used by graduation, §10). `features.attachmentReactions` defaults to true. HFY sets it to false, because the API rejects attachment targets (`comments.js:164`).
- **Order.** The order and pagination slots described in §8.
- **Conformance.** CC-18 to CC-22: attachments round-trip; photo-only create; `desc` order with a stable cursor that does not repeat across an insert; the `order` value is bound into the cursor (a mismatch gives `cursor_invalid`); and the no-op edit rule holds with attachments.

### 9.2 API (task `hfy-comments-photos-desc-api`)

- **Uploads.** `POST /uploads` accepts `purpose: "post" | "comment"` (default `post`). For `comment`, the key is `uploads/comments/<ulid>/<safe-name>`, using the same `safeName`, 10 MB cap and signed content type (`api/src/uploads.js:15-35`, `presign.js:14-20`). Comment photos accept only `image/jpeg`, `image/png` and `image/webp`, because the client always sends JPEG (§9.3).
- **`comments.create` and `comments.update`** (`comments.js:112-144`) accept `attachments`:
  - at most 4;
  - `url` (absolute or relative to `mediaPublicBase`) matches `^/uploads/comments/<ULID>/[a-z0-9][a-z0-9._-]{0,80}$`;
  - `mime` is one of the 3 types;
  - `alt` is 500 characters or fewer;
  - `width` and `height` are integers in 1–100000.

  The server assigns `id = <upload ulid>`. Each attachment is verified with `HeadObject` (exists, `ContentType` equals the declared mime, size ≤ 10 MB). It uses the new `UploadReads` grant and runs in parallel with a 2 s timeout. `body()` (`comments.js:53-58`) allows an empty body when attachments are present. Edit may remove attachments but not add new ones; changing photos means a new comment, which keeps the audit simple.
- **Delete.** Comment delete keeps the S3 objects, as post deletes do today. An S3 lifecycle rule for orphans is a follow-up and is noted in the risks.
- **Contact-info guard.** The shared validator from the privacy domain (R-18) runs on `body` and every `alt`.
- **Routes.** `routes.js:38-39,63` update the summary and the MCP description: "List comments … oldest first by default; order=desc for newest first." The MCP input schema gains an optional `order` enum.

### 9.3 Browser normalization (task `hfy-comment-photos-ui`)

`islands/src/lib/photo.js`:

```js
normalizePhoto(file) -> Promise<File>
```

1. Decode with `createImageBitmap(file, { imageOrientation: "from-image" })`, which bakes in the EXIF orientation.
2. Scale so the long edge is 2560 px or less.
3. Draw to a canvas and encode `image/jpeg` at quality 0.85.

The result has no EXIF, which removes GPS, a location and therefore contact-adjacent data under R-18. It is an upright JPEG, which Gramps can thumbnail and region-tag (the digest found that Gramps 6.0.6 on macOS cannot read HEIC or WebP and ignores EXIF orientation).

- The picker uses `accept="image/jpeg,image/png,image/webp"`. Leaving out `image/heic` makes iOS Safari hand over a JPEG from the photo library. This must be confirmed on a real iPhone (task `soc-upload-normalization-probe`).
- A decode failure shows "that photo type didn't work here. try a jpeg or a screenshot."
- `uploadPhoto` (`islands/src/lib/upload.js:2-7`) becomes `uploadPhoto(api, file, { purpose })` and runs `normalizePhoto` first.
- With `commentPhotosV1` on, the post composer (`my-posts.jsx:103-115`) uses the same normalization, so new post photos stop carrying GPS. Existing post photos are untouched; this is noted in the risks.

### 9.4 UX

- **375 px.** The composer row is "say something" (16 px input) plus a 44 px camera icon button plus "post". Attached photos show as a horizontal row of 64 px thumbnails, each with a remove button that has a 44 px hit area. Alt text sits behind "add a description" to keep the row short. Upload progress shows as text in the composer: "adding photo…". Posting is disabled until uploads finish. In the thread, comment photos display as a grid of up to 2 columns at 375 px; a tap opens the full image in a new tab.
- **Desktop.** The same controls on one row, and photos as a grid of up to 4 columns within the comments column width.
- **Errors.**
  - Presign failure: "that didn't upload. try again."
  - S3 PUT 403 because the presign expired: one automatic re-presign and retry.
  - Server 400 on a HEAD mismatch: "that photo didn't finish uploading. add it again."

## 10. Graduating a comment photo into a record photo (R-02)

**Who and where.** Admins only (`can.graduate` from `/api/me`), with `graduateV1`. The action is on each photo of a comment through `renderAttachmentActions`: "add to a family page…".

**Contract required from the sync domain** (cross-domain, §15):

- `syncOps.apply(actor, { idempotencyKey, ops })` is an in-process call in hfy-api. It applies Gramps-object ops to the cloud record store with D-15 audit, validators (R-18, R-19) and `base_version` / If-Match semantics.
  - It must support `add Media` and an append to `Person.media_list` with a `MediaRef {ref, rect:null, private:false}`.
  - It throws `SyncError { code: "conflict" | "validation" | "unavailable", pointer? }`.
- `syncOps.mintHandle("Media")` and the record media prefix `R_MEDIA_PREFIX` (S3 keys outside every `--delete` sync prefix). This design uses the placeholder `records/media/`, to be replaced by the sync design's name.
- A desktop pull (the `hfy_sync` addon) that materializes a cloud-held binary into the Gramps media folder and sets the local path and MD5.

**Route** (task `hfy-graduate-api`):

`POST /api/comments/:id/attachments/:aid/graduate`
Request body: `{ subject:"person:<id>|post:<ulid>", person:"<gramps_id>", title?: string ≤ 200, description?: string ≤ 1000 }`
Response: `201 { media:{ handle, gramps_id? }, person, state:"done" }` for a new graduation, or `200` with the same body when it was already done for the same person (idempotent).

**Phases.** Each phase is idempotent. The idempotency key is `graduate:<comment id>:<aid>`.

1. **Reserve.** `Update` the comment's `attachments[i].graduated = {state:"pending", media_handle:H, person, by, at}`. The condition is that `graduated` is absent, or is pending with the same `media_handle`, which makes a retry continue. `H` is minted once and stored here. A record already done for the same person returns 200. Done for another person returns `409 already_graduated`.
2. **Copy.** `CopyObject` from `uploads/comments/<ulid>/<name>` to `${R_MEDIA_PREFIX}<H>.jpg` with `ChecksumAlgorithm:"SHA256"`. S3 computes the SHA-256 and returns it, so the Lambda never reads the bytes. The copy target is deterministic, so a retry overwrites the same bytes. Source `ContentType` must be `image/jpeg`, `image/png` or `image/webp`. PNG and WebP are allowed, but the desktop materializer converts them.
3. **Apply.** `syncOps.apply` with `add Media {handle:H, mime, desc:title ?? alt, path:<cloud key per sync design>, attribute hfy:source = "comment-photo:<thread>/<comment>/<aid>", sha256}` and `update Person <handle of person> media_list += MediaRef(H)`, using the person's current `base_version`. On `conflict` it re-reads the person and retries once; an append is commutative.
4. **Finalize.** One transaction:
   - `Update` the attachment `graduated.state = "done"`;
   - the AUDIT# item `op:"graduate"` on the comment;
   - `contribOps(kind:"photo_to_record", actor: the photo's author)`.

   After commit, `onGraduated` notifies the photo's author unless the admin is the author.

**Failure handling:**

- A `SyncError validation` releases the reservation (`graduated = {state:"failed", code, pointer}`) and returns `400` with the pointer, so the admin can correct the title and retry.
- `unavailable` returns `503 sync_unavailable`, and the reservation stays pending, so a retry resumes.
- In the UI, a pending reservation older than 15 minutes shows "retry".

**IAM delta.** `s3:PutObject` on `${MediaBucket}/${R_MEDIA_PREFIX}*`, added in the graduation task unless the sync domain already grants it.

**UX** (task `hfy-graduate-ui`):

- **Desktop.** An inline form under the photo (not a modal) with three parts:
  - "which page?", a person picker over the people corpus (`suggestPeople`, `shell.jsx:10`), defaulting to the thread's person on `person:` threads and empty on post threads;
  - "title", prefilled from the alt text;
  - "add to page" and "cancel" buttons.

  The button reads "adding…" while pending. On success, the photo gets a badge "on {name}'s page" linking to `/person/?id=<x>#photos`.
- **375 px.** The same form stacked: 16 px inputs, full-width 44 px buttons, and the person picker as a list under the input.
- **Errors.**
  - Validation: inline under "title".
  - `503`: "couldn't add it to the page right now. try again in a minute."
  - `409` for another person: "this photo is already on {name}'s page."

The graduated photo appears on the person's photos section as soon as the records domain renders the cloud record store. Until then, the badge says "added — it shows on the page after the next sync."

## 11. Moderation (R-32)

### 11.1 Model

The moderation state is stored inline on the item, for cheap list filtering, and mirrored in a `MOD#` item, which feeds the queue and serves as the overlay for record targets:

```ts
interface Moderation {            // on post.moderation, comment.moderation
  state: "hidden" | "changes_requested" | "question";
  hidden: boolean;                // question may be visible (hidden:false)
  by: { id, label };              // shown to author and admins (the author needs to know whom to answer in chat)
  at: string;
  note?: string;                  // admin's message; author + admins only; ≤ 1000; contact-info guarded
  open: true;                     // removed (whole object) when closed
}
// photo-level: attachments[i].moderation = { hidden:true, by, at }
// reason (private) lives only in AUDIT#; never returned to any client
```

```
PK MOD#<kind>:<id>  SK META
  { entity:"mod", target:{kind, id, thread?, attachment?}, author_id, state, hidden, by, at, note?,
    open:true|false, resolved_by?, resolved_at?, version, GSI1PK:"MODQ#open"|"MODQ#closed", GSI1SK:"<at>#<kind>:<id>" }
kind ∈ post | comment | photo | note | mediaref
id   = <ulid> (post) | <thread>/<ulid> (comment) | <parent kind>:<parent id>#<attachment id> (photo)
       | <note handle> (note, records domain) | <person handle>#<media handle> (mediaref, records domain)
```

What the targets mean:

- **Posts** cover what members share on `/posts/` and the timeline. **Stories** are the person-page stories, posts with `subject=<id>`, plus record notes once self-editing exists (R-09).
- **Photos** are post and comment attachments, plus record media references.
- **Notes** and **mediarefs** are record data. Hiding them is a site overlay that the records domain's read path applies (task `hfy-moderation-record-targets`). Until that path exists, the route answers `422 unsupported_target` for those kinds.

### 11.2 Transitions

| From | Action (by) | To | Side effects (one transaction unless noted) |
| --- | --- | --- | --- |
| none | `hide` (admin) | `hidden`, `hidden:true` | Inline state + `MOD#` (open) + AUDIT# `op:"moderate"` + contribution `hideOps(true)`. After commit: `moderation_hidden` to the author. |
| none | `request_changes` + note (admin) | `changes_requested`, `hidden:true` | Same, with the note. After commit: `moderation_request` with `detail = note`. |
| none | `ask` + note, `hide` false by default (admin) | `question`, `hidden:<hide>` | Same. After commit: `moderation_question` with `detail = note`. |
| hidden or open | `unhide` (admin) | none (closed) | Remove the inline state, `MOD#` open → closed, audit, `hideOps(false)`. After commit: `moderation_unhidden`. |
| `changes_requested` or `question` | Effective author edit (`content.update` or `comments.edit` changes the body, title or attachments) | none (closed, `resolved_by: author`) | Done inside the author's edit transaction: `Update MOD#`, inline removal, `hideOps(false)`. After commit: `moderation_resolved` to the asking admin. This is "the item becomes visible when the author updates it", as io asked. |
| `hidden` (plain hide) | Author edit | stays hidden | The banner tells the author a moderator must unhide it. |
| any | Moderator delete, or author delete | gone | `MOD#` closed in the delete transaction, `revokeOps`. |
| Own item | any moderation action | — | `400 self_moderation`. An admin withdraws or deletes their own item instead. |

An admin's earlier ask that is still open can be replaced by a new action, which closes the old record and opens a new one. A stale `version` (the item's `updated_at` or `edited_at`) returns `409`.

### 11.3 Enforcement (server, task `hfy-moderation-api-core`)

One function, `moderationVisible(item, viewer) = !item.moderation?.hidden || viewer.id === item.author.id || viewer.admin`, applied where the API reads:

- **Content** (`content.js:79-83` `visible()`, `:143-152` `accept`): through the kit's updated `canView` (content 0.3.0), so every ContentSource host gets the same rule and the CS suite checks it.
- **Comments.**
  - `list` (`comments.js:87-111`) filters hidden rows for other viewers. The page is filled to `limit` by over-fetching up to 3 times.
  - `checkPostVisible` (`:37-45`) inherits the post rule through `getPost`, so a hidden post hides its thread exactly as `withdrawn` does.
  - `create`, `edit` and `react` on a hidden comment answer `not_found` to other viewers.
- **Photos.** Views strip attachments where `moderation.hidden` is set, except for the author and admins. Note that an already-known `/uploads/…` URL still serves the bytes to signed-in members (see the risks); delete removes the reference, not the object.
- **Contributions.** `hidden` events are filtered (§7.5).
- **Timeline and `/posts/`** follow from `canView`.

### 11.4 Kit changes

- **`@io-kit/content` 0.3.0** (task `kit-content-moderation`):
  - `Post.moderation?`, `Attachment.moderation?` and `Capabilities.moderate`.
  - `computeCan` sets `moderate = admin && !own`, and `canView` respects `moderation.hidden`.
  - `AuditOp` adds `"moderate"`, and `ContentSource.moderate?(id, action)` is optional, behind capability `moderation`.
  - `PostCard` and `ArticleView` add:
    - a "hidden" badge for admins;
    - an author banner: "a moderator hid this." or "{by} asked: {note} — edit it to show it again.";
    - a `renderModeration(post)` slot.
  - New CS cases cover visibility by role, the `can.moderate` matrix and audit emission.
- **`@io-kit/comments` 0.3.0** (task `kit-comments-moderation`):
  - `Comment.moderation?`, `Attachment.moderation?`, `Capabilities.moderate`, `AuditOp "moderate"` and an optional `CommentSource.moderate?(threadId, id, action)`.
  - `ModerationMenu` (`react.tsx:224-247`) becomes a menu with "hide", "ask for changes…", "ask a question…", "unhide" (when hidden) and "delete as moderator" (existing). The "ask" form has:
    - a note textarea (16 px, 1000-character counter, required);
    - a checkbox "keep it hidden until they update it", checked by default for changes and unchecked for questions;
    - "send" and "cancel".
  - Comments show the same badge and banner as posts.
  - New CC cases CC-23 to CC-27.
- **Shared.** Labels are overridable everywhere. The menus render only when `can.moderate` is true. The server never trusts the client: the HFY route re-checks `actor.admin`.

### 11.5 Routes (tasks `hfy-moderation-api-core`, `hfy-moderation-ask-api`)

`POST /api/moderation`:

```json
{ "target": { "kind": "post", "id": "<ulid>" }
          | { "kind": "comment", "id": "<ulid>", "thread": "person:<gramps_id>" }
          | { "kind": "photo", "parent": { "kind": "post", "id": "<ulid>" }, "attachment": "<attachment id>" },
  "action": "hide" | "unhide" | "request_changes" | "ask",
  "note": "required for request_changes and ask; 1..1000",
  "reason": "optional, ≤ 200, private (audit only)",
  "hide": false,
  "version": "<updated_at|edited_at the admin saw>" }
```

It returns `200 { target, moderation | null, item: <viewer-specific view> }`.

Errors:

- `400 validation` (field `note`, `action` or `target`);
- `400 contact_info` (the R-18 guard on `note`);
- `400 self_moderation`;
- `403 forbidden` (not an admin);
- `404 not_found`;
- `409 conflict` (stale version);
- `422 unsupported_target`;
- `503 busy`.

`GET /api/moderation?state=open|closed&cursor=` (admins) returns `{ items:[{ target, state, hidden, by, at, note?, author:{id,label}, href }], cursor }`. It queries GSI1 `MODQ#<state>` in descending order.

Neither route has an MCP entry or a `POLICY_ROWS` row, so both stay off MCP in v1. Audit is AUDIT#`<target id>` with `op:"moderate"`, `before` and `after` holding the moderation objects, plus `reason`. `buildCaps().audit.ops` adds `moderate` and `graduate`.

### 11.6 UX (tasks `hfy-moderation-ui`, `hfy-moderation-queue-page`)

- **Admins** see a 44 px "moderate" control on each post card, comment, comment or post photo, and story list item (only with `can.moderate`). On desktop it opens a small menu under the control. At 375 px it opens a bottom Sheet with the same items as 56 px rows. The "ask" form is inline on desktop and inside the sheet at 375 px.
  - After an action, the item shows a "hidden" tag for admins with a one-tap "unhide".
  - A status ping reports the outcome: "hidden. they'll get a note." or "sent."
- **Authors** of a hidden item see it in place with a neutral banner (role `status`, not a danger alert). It holds the moderator's note and an "edit" button. For `changes_requested`, the banner says editing will make it visible again. The inbox item links to the same place. Once chat ships, "reply in chat" links to a direct chat with the moderator.
- **Everyone else** does not see the item. A hidden post's URL shows the existing not-found copy (`posts.jsx:11`).
- **`/me/moderation/`** is a new repo-owned page with an island, for admins only; anyone else gets the sign-in or not-found gate. It shows open items first: kind, author, when, the state and the note, then "open" and "unhide". A "closed" tab lists closed items, paged. The page is added to `heads.mjs`, `copy.mjs`, the README lists and `bundle.test.mjs`.

## 12. Data model (consolidated; table `hfy-app`, keys `PK/SK`, index `GSI1`, TTL attribute `ttl`, `app-stack.yaml:42-62`)

| Entity | PK | SK | GSI1PK / GSI1SK | TTL | Written by |
| --- | --- | --- | --- | --- | --- |
| Inbox record | `INBOX#<principal>` | `N#<ulid>` | — | unread +365 d, read +90 d | kit `DynamoNotificationStore` |
| Inbox unread copy | `INBOX#<principal>` | `U#<ulid>` | — | +365 d | kit |
| Inbox counter | `INBOX#<principal>` | `COUNT` | — | none | kit |
| Inbox group pointer | `INBOX#<principal>` | `G#<group>` | — | +365 d | kit |
| Record follow | `RSUB#<principal>` | `REC#person:<gramps_id>` | `RECSUB#person:<gramps_id>` / `<principal>` | none | subscriptions routes |
| Contribution event | `CONTRIB#<principal>` | `E#<ulid>` | `CONTRIBS` / `<ulid>` | none | `contrib.js` builders |
| Self-edit daily cap | `CONTRIB#<principal>` | `CAP#self_edit#<subject>#<YYYY-MM-DD>` | — | +2 d | records domain through `contrib.js` |
| Site counters | `CSTAT#site` | `TOTAL`, `D#<YYYY-MM-DD>` (TTL +800 d), `M#<YYYY-MM>`, `LINE` (TTL +2 h) | — | as noted | `contrib.js` |
| Person counters | `CSTAT#person:<principal>` | `TOTAL`, `M#<YYYY-MM>` | — | none | `contrib.js` |
| Moderation record | `MOD#<kind>:<id>` | `META` | `MODQ#open` or `MODQ#closed` / `<at>#<kind>:<id>` | none | moderation routes, author edits |
| Inline moderation | (existing post and comment items) | — | — | — | `post.moderation`, `comment.moderation`, `attachments[i].moderation` |
| Contribution link | (existing post and comment items) | — | — | — | `post.contrib`, `comment.contrib` |
| Graduation marker | (existing comment item) | — | — | — | `comment.attachments[i].graduated = {state, media_handle, person, by, at, code?}` |
| Audit | `AUDIT#<id>` | `<at>#<ulid>` | `AUDIT` / same | none | new ops `moderate` and `graduate` (`txn.js:5-20`) |

S3 (bucket `harrisonfamily-frontend`):

- `uploads/comments/<ulid>/<name>.jpg` holds comment photos. It is served through the existing gated `/uploads/*` behavior with nosniff and the sandbox CSP (HFY-R58, `scripts/infra/add-uploads-behavior.sh`). The bucket CORS already allows PUT from the site origin (`media-bucket-cors.json`).
- `${R_MEDIA_PREFIX}<media handle>.jpg` holds graduated record media. The sync domain names this prefix, and it must be outside every `--delete` sync prefix.

No new GSI. Partition hot spots: `CSTAT#site` (handled by the conflict retry) and `GSI1PK=CONTRIBS` (append-only, low volume).

## 13. API catalog (all under `/api`, session cookie, JSON; 415 rule and `no-store` headers apply automatically)

| Route name | Method and path | Purpose | Main errors |
| --- | --- | --- | --- |
| `me.get` | GET `/me` | Who am I, plus admin capabilities | 401 |
| `notifications.inbox.list` | GET `/notifications/inbox` | Inbox page | 400 cursor_invalid, 401 |
| `notifications.inbox.count` | GET `/notifications/inbox/unread-count` | Unread count | 401 |
| `notifications.inbox.read` | POST `/notifications/inbox/read` | Mark read (ids or all) | 400 invalid mark-read, 401 |
| `subscriptions.get` | GET `/subscriptions?subject=` | Am I following? | 400 |
| `subscriptions.list` | GET `/subscriptions` | My follows | 400 cursor_invalid |
| `subscriptions.put` | PUT `/subscriptions/person/:id` | Follow | 400 self_subscribe, 404 |
| `subscriptions.remove` | DELETE `/subscriptions/person/:id` | Unfollow | — |
| `comments.list` (changed) | GET `/comments?subject=&order=asc\|desc&cursor=&limit=` | Order option | 400 cursor_invalid (cursor from the other order) |
| `comments.create` / `comments.update` (changed) | POST / PATCH `/comments…` | Attachments, photo-only comments | 400 validation (attachments, upload_missing), 400 contact_info |
| `uploads.presign` (changed) | POST `/uploads` `{…, purpose}` | Comment photo prefix | 400 validation |
| `contributions.list` | GET `/contributions?author=` | Person feed | 400 |
| `contributions.stats` | GET `/contributions/stats?author=` | Per-person count | — |
| `contributions.site` | GET `/contributions/stats` | Site total and feed line | — |
| `moderation.act` | POST `/moderation` | Hide, unhide, request changes, ask | §11.5 |
| `moderation.queue` | GET `/moderation?state=` | Admin queue | 403 |
| `comments.graduate` | POST `/comments/:id/attachments/:aid/graduate` | Graduation | 400, 403, 404, 409 already_graduated, 503 sync_unavailable |

None of these routes gains an `mcp` member, so MCP tools/list stays exactly as it is today. The `mcp-conformance` test asserts this. The `comments.list` MCP schema gains only the optional `order` argument.

## 14. Kit change summary (io-kit; each is a separate package PR with a changeset, HFY-R7)

| Package | Version | Change | Consumers to re-check |
| --- | --- | --- | --- |
| `@io-kit/notify` | 0.5.0 | Inbox store contract, in-memory and Dynamo stores, `createDelivery`, inbox handler routes, query support, schema `$defs` and fixtures, NI conformance suite, `inbox`/`inboxText`/`many` templates, `detail` | coach and vagamod use the 0.4 API unchanged (additive) |
| `@io-kit/notify` | 0.6.0 | `NotifyApi` inbox methods, `syncAppBadge`, `useInbox`, `NotificationBell`, `NotificationInbox`, service-worker push message, CSS tokens | additive |
| `@io-kit/comments` | 0.2.0 | Attachment fields, `CreateInput.attachments`, Composer upload slot and placeholder, photo-only submit, `order` and `composerPosition`, `renderMore`, `renderAttachment(Actions)`, `features.attachmentReactions`, CC-18 to CC-22 | vagamod and coach donors (D-12) default to unchanged behaviour (`maxAttachments` 0, order asc) |
| `@io-kit/comments` | 0.3.0 | Moderation model, `can.moderate`, ModerationMenu actions and ask form, badges and banners, `AuditOp "moderate"`, CC-23 to CC-27 | same |
| `@io-kit/content` | 0.3.0 | Moderation model, `canView`, `can.moderate`, PostCard badge, banner and slot, `AuditOp "moderate"`, CS cases | coach, enceladus (documents). Unmoderated posts behave exactly as before. |

harrisonfamily pins (installs are separate HFY tasks):

- api: notify 0.5.0 → 0.6.0, comments 0.2.0 → 0.3.0, content 0.3.0.
- islands: notify 0.6.0, comments 0.3.0, content 0.3.0.

All pins are exact, which replaces today's `^0.1.0` and `^0.4.0` (`api/package.json:20,23`). Islands content jumps from 0.1.1 to 0.3.0, which also brings in the 0.2.0 DocumentEditor (Cloudscape). The bundle-size check in `hfy-person-sections-capped` must show that esbuild tree-shakes it away, or the island imports from narrower entry points.

## 15. Cross-domain contracts

| Other domain | This domain provides | This domain needs |
| --- | --- | --- |
| Proposals (R-06, R-07) | `notifier.onProposalSubmitted`, `notifier.onProposalDecided`, `contribOps(kind:"proposal_accepted")`, `transact()` v2 (Update, ConditionCheck for "proposal still pending") | Calls after commit; the review page URL for `proposal_submitted` |
| Records and self-edit (R-08, R-09) | `notifier.onRecordChanged(changes, {silent})`, `contribOps(kind:"self_edit")` with the CAP rule, the moderation overlay contract for `note` and `mediaref` | Calls after each committed record write; applies `MOD#note:` and `MOD#mediaref:` in the record read path; renders graduated media |
| Sync (R-03 to R-05) | — | `syncOps.apply`, `mintHandle`, `R_MEDIA_PREFIX`, desktop materialization of cloud-held media, `silent:true` on bulk import, Gramps pushes reported as `source:"gramps_sync"` |
| Image tagging (R-29 to R-31) | `contribOps(kind:"tag")`, `onRecordChanged(source:"tag")` | The tag commit hook |
| Privacy guard (R-18) | Call sites: comment `body`, `alt`, moderation `note`, graduation `title`/`description` | `rejectContactInfo(text) → {ok} \| {code:"contact_info", field}` |
| Navigation (R-20, R-21) | The bell in `.hfy-bar__end`; an "inbox" link for the settings hub | The shell edits are sequenced: both domains touch `shell.jsx` |
| Webchat (R-33 to R-41) | `moderation_question` with a "reply in chat" link; `useInbox.subscribe` seam for a realtime signal | The chat deep-link format; an optional realtime channel later |

## 16. Testing

- **Kit.**
  - Vitest units plus conformance suites: NI-01 to NI-12 run against both stores; CC-18 to CC-27; new CS moderation cases.
  - Schema fixtures are validated the way the existing notify tests validate them.
  - jsdom React tests for Bell, Inbox and ModerationMenu: roles, names, focus return, the 9+ badge, an optimistic read with rollback, the live region announcing only increases.
  - The release gate is `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- **API** (vitest with the extended `fake-ddb`):
  - `transact`: Update, ConditionCheck, the conflict retry with token reuse, and non-retry on a condition failure.
  - Inbox: persists with push off, the badge value is in the push payload, coalescing, mark-read idempotency.
  - Follow routes: 404, self, idempotent PUT and DELETE.
  - Contribution builders: merge for purge batches of at least 30 comments, revoke, hide, the CAP rule, the MCP `via` stamp.
  - `pickLine`: the golden table.
  - Moderation transitions, table-driven, one case per row of §11.2.
  - Visibility matrix: author, admin and other viewer × hidden, question-visible and none.
  - Graduation phases with fault injection after each phase, plus resume.
  - Caps and MCP parity: no new tools.
- **Islands** (Playwright, mocked API; at 375×812, 768×1024, 1280×800 and 1440×900):
  - `inbox.spec.mjs`
  - `person-social.spec.mjs`
  - `comment-photos.spec.mjs` (a normalization fixture with an orientation-6 JPEG carrying GPS EXIF: the output is upright with no EXIF)
  - `moderation.spec.mjs`
  - `follow.spec.mjs`
  - `feed-line.spec.mjs`

  axe runs on every state. Theme-lint must stay green (no literals). `bundle.test.mjs` is updated, and `npm run build -- --check` must be clean with the outputs committed (HFY-R58).
- **D-11 per flag.** 16 px inputs, 44 px targets, one control height per row, no horizontal scroll at 375, axe clean, and the installed iPhone PWA (io G-uat): badge, push tap deep link, sheet safe areas and photo pick from the library.

## 17. Rollout

1. **Kit releases**, in order: notify 0.5.0 → notify 0.6.0; comments 0.2.0 → 0.3.0; content 0.3.0. Each goes through the Release workflow. HFY pins manually with a local CodeArtifact token (HFY-R62).
2. **App-stack change set.** IAM for `ConditionCheckItem` and the comment uploads (`hfy-social-iam`). This needs io's go-ahead (AGENTS.md), and the orchestrator deploys it (HFY-R32).
3. **API releases.** Inbox and `/api/me`, follows, contributions and the backfill, comment photos and order, moderation. The server side is live with every UI flag off. Run the contribution backfill (`--dry-run`, then `--apply`).
4. **Islands releases.** All new surfaces start off. Use the `?hfy_flags=inboxV1,…` preview for the D-11 audit and io UAT.
5. **First flip** (`hfy-social-flip-1`): `inboxV1`, `recordSubsV1`, `commentPhotosV1`, `contribV1`. Each needs a green D-11 audit and io approval (HFY-R8).
6. **Second flip** (`hfy-social-flip-2`): `moderationV1` and `graduateV1`. These wait on io naming moderators in `config/admins.json` (§19 SOC-D14), on the privacy and terms amendment (SOC-D15), and, for graduation, on the sync op API being live.

**Rollback.**

- Turning a flag off removes the UI.
- Server writes stay harmless: inbox items wait, and ledger rows stay correct.
- Hidden items stay hidden with the UI off. Admins can still call `POST /api/moderation {action:"unhide"}` with their session, and this procedure is documented in the how-to.
- `transact()` v2 is backwards compatible with every existing caller.

## 18. Error-handling catalog

| # | Situation | Detection | Behaviour | User copy (DS voice) | Telemetry |
| --- | --- | --- | --- | --- | --- |
| E1 | Inbox write fails after a committed write | `store.add` throws | Logged and counted; the write still returns 201; push is still attempted | — | `inbox_failed{type}` |
| E2 | Push endpoint gone | 404 or 410 from web-push | Subscription dropped (existing) | — | `push_dropped` |
| E3 | Unread counter drift | Negative, stale or missing count with `U#` items present | Recount from `U#` and `Put COUNT`; clamp at 0 | — | `inbox_recount` |
| E4 | Mark-read race (already read) | Condition fails on `U#` | Chunk re-run without the missing ids; 200 with `updated` | — | — |
| E5 | Counter `TransactionConflict` | `CancellationReasons` are all TransactionConflict | Up to 3 retries with jitter, same token; then 503 `busy` | "that didn't post. it's still here — try again." | `txn_conflict_retry`, `txn_busy` |
| E6 | Real version conflict | Condition failure on the main item | 409 conflict (unchanged) | "someone changed this just now. reload and try again." | — |
| E7 | Transaction over 100 items | `assertTxnSize` | Programming error caught by tests; purge batches resize dynamically | — | — |
| E8 | Comment photo missing or wrong type in S3 | HEAD 404 or ContentType mismatch | 400 `upload_missing` | "that photo didn't finish uploading. add it again." | `upload_missing` |
| E9 | Presign expired before PUT | S3 403 | Client re-presigns once and retries | "adding photo…" (no error unless the second try fails) | — |
| E10 | Photo cannot decode in this browser | `createImageBitmap` rejects | No upload | "that photo type didn't work here. try a jpeg or a screenshot." | client console only |
| E11 | Follow a missing page | Person JSON 404 | 404 | "that page wasn't found." | — |
| E12 | Moderation by a non-admin | `actor.admin` false | 403 | (no control is shown) | `mod_forbidden` |
| E13 | Moderation note contains contact info | R-18 guard | 400 `contact_info` | the privacy domain's line | — |
| E14 | Record-target moderation before the records domain ships | No adapter | 422 `unsupported_target` | "that can't be hidden yet." | — |
| E15 | Graduation copy fails | S3 error | 503; reservation stays pending | "couldn't add it to the page right now. try again in a minute." | `graduate_copy_failed` |
| E16 | Graduation rejected by sync validation | `SyncError validation` | Reservation set to `failed`; 400 with pointer | inline under the field | `graduate_invalid` |
| E17 | Graduation sync conflict | `SyncError conflict` | Re-read the person and retry once; then 503 | as E15 | `graduate_conflict` |
| E18 | Already graduated to another person | Marker done, different person | 409 `already_graduated` | "this photo is already on {name}'s page." | — |
| E19 | Contribution feed post lookup partial | BatchGet UnprocessedKeys | Retry once, then omit the event (fail closed) | — | `contrib_feed_omitted` |
| E20 | Feed line has no eligible window | `pickLine` returns null | No number shown | "add a photo or a story to get things going." | — |
| E21 | Record-change fan-out spans many records | Large `changes` list | One GSI query per subject; per-recipient digest; bounded concurrency 8; `silent` for imports | — | `fanout_ms`, `fanout_recipients` |
| E22 | Inbox navigate is not same-origin | Validator in store and client | Rejected at `add` (programming error); client refuses to navigate | — | `bad_navigate` |
| E23 | Signed out while the bell is polling | 401 | Polling stops; the bell hides; the shell's own session logic takes over (HFY-R66) | — | — |

## 19. Decisions

The same list, with `needs_io` flags, is returned in the structured summary.

- **SOC-D1** Flags `inboxV1`, `recordSubsV1`, `commentPhotosV1`, `contribV1`, `moderationV1`, `graduateV1`; `graduateV1` implies the photo and moderation flags.
- **SOC-D2** The inbox lives in `@io-kit/notify`: a store keyed on PK/SK only (`N#`, `U#`, `COUNT`, `G#`), no GSI, coalescing groups.
- **SOC-D3** Delivery persists first. The inbox is always written, and push depends on VAPID plus per-type prefs. `new_family_post` is push-only.
- **SOC-D4** Retention: unread items 365 days, read items 90 days after reading.
- **SOC-D5** Contribution definition and weights (§7.1).
- **SOC-D6** MCP comments count (`via:"mcp"`); MCP posts count when a human publishes; Gramps desktop pushes do not count.
- **SOC-D7** Deletes revoke (author, moderator, cascade); hide and withdraw keep the count but hide the entry.
- **SOC-D8** The feed-line algorithm (§7.4): thresholds 3 and 5, UTC buckets, 1 h cache with dwell.
- **SOC-D9** Counters sit in the write transaction (`transact` v2 with conflict retry), not in a Streams aggregator.
- **SOC-D10** Person page: 50/50 split from 64rem; caps at 448 and 576 px; "older" expands, then fetches; no nested scroll.
- **SOC-D11** Comments newest first with the composer on top under `contribV1`. With the flag off, the label becomes "show more comments".
- **SOC-D12** Comment photos: the `uploads/comments/` prefix, JPEG normalization in the browser (orientation baked in, EXIF and GPS stripped), 4 per comment, photo-only comments allowed, the same normalization for post photos.
- **SOC-D13** Moderation: hide and unhide; request changes hides until the author edits, then auto-unhides and notifies the admin; a question does not hide by default but can; photo-level hide; record targets through an overlay; not exposed to MCP.
- **SOC-D14** Moderators are `config/admins.json`, currently empty. io names them. **io-owned.**
- **SOC-D15** Privacy and terms amendment: stored in-app notifications and their retention, moderation, displayed contribution counts, comment photos becoming family record, EXIF stripping. **io-owned.**
- **SOC-D16** Admin status reaches the client only through `GET /api/me` and per-item `can.moderate`, never through `/auth/session`.
- **SOC-D17** Graduation runs reserve → copy (S3 computes SHA-256) → `syncOps.apply` → finalize, all idempotent; no step-up.
- **SOC-D18** Follow is explicit and silent to the followed person; owners are implicitly subscribed; coalescing per record; a digest above 3 per batch; imports are silent.
- **SOC-D19** UX: a bottom Sheet under 43rem and an anchored panel from 43rem; `/me/inbox/`; 60 s polling while visible, plus a service-worker message and BroadcastChannel; signal-then-fetch later.
- **SOC-D20** Kit versions as in §14; HFY pins exact.

## 20. Risks

- **ConditionCheck needs a new IAM action** (`dynamodb:ConditionCheckItem`). Until the app-stack change deploys, any transaction with `checks` fails with AccessDenied. Ship the IAM change before or with the first caller, and add a test that fails if a `checks` caller exists while the template lacks the action.
- **Shared counter rows.** `CSTAT#site` rows sit in every contribution transaction. At family volume conflicts are rare and retried. A bulk backfill must run with a single writer.
- **Islands content jumps from 0.1.1 to 0.3.0**, which pulls in 0.2.0 (DocumentEditor, Cloudscape). There is a bundle-size risk, and the D-12 donor re-adoptions (coach, vagamod) must pass the new CS and CC cases before HFY adopts.
- **iOS transcoding is unverified.** Excluding `image/heic` from `accept` should make iOS Safari deliver JPEG, but this needs confirmation on a real device. If iOS hands over HEIC anyway, `createImageBitmap` decodes it on recent Safari; older iOS fails with copy E10.
- **The server cannot verify browser normalization.** A hand-crafted upload can still carry EXIF GPS. Graduation's desktop materializer must strip EXIF again (sync domain), and existing post photos keep any EXIF they were uploaded with.
- **Hidden photos remain fetchable.** Hiding removes the reference, but the `/uploads/…` URL still serves the bytes to any signed-in member who already has it. Only moderator delete plus a future orphan cleanup removes the object. Orphaned uploads (deleted comments and posts, abandoned presigns) accumulate without an S3 lifecycle rule.
- **Moderation is unusable until io names moderators.** `config/admins.json` is empty (HFY-R73). R-10 notifications also have no recipients until then.
- **Graduation depends on the sync domain's op API, media prefix, handle minting and desktop materialization.** If those slip, `graduateV1` cannot flip. Its server route answers 503 meanwhile.
- **Record-change producers depend on other domains calling the hooks and passing `silent:true` on import.** Forgetting `silent` on the first cloud import would spam every member. Mitigation: the hook refuses a non-silent batch over 50 subjects unless `force:true`, and logs `fanout_refused`.
- **Two domains edit `shell.jsx`** (bell here, Me and gear in navigation). Sequence their PRs and rebase (HFY-R7).
- **Moving the comments host into `#hfy-person-social` changes a pinned contract** (`person-page.spec.mjs:86-90`). The flag-off path must keep the old structure until the flip.
- **Polling cost and staleness.** A 60 s poll per open tab is cheap, but the bell can lag up to a minute without a realtime transport. Pushes trigger an immediate refresh where push is on.
- **Counts and copy.** The feed line uses UTC days, which differ slightly from the family's local midnight. This is acceptable for "past N days" copy.

## 21. Tasks (summary; full ACs in the structured output)

| Wave | Key | Repo | Type |
| --- | --- | --- | --- |
| W0 | soc-io-moderators-terms | none | no_code |
| W0 | soc-upload-normalization-probe | none | no_code |
| W1 | kit-notify-inbox-server | io-kit | code_only |
| W1 | kit-notify-inbox-react | io-kit | code_only |
| W1 | kit-comments-photos-order | io-kit | code_only |
| W1 | kit-comments-moderation | io-kit | code_only |
| W1 | kit-content-moderation | io-kit | code_only |
| W1 | hfy-txn-update-check | harrisonfamily | github_pr_deploy |
| W1 | hfy-social-iam | harrisonfamily | github_pr_deploy |
| W2 | hfy-inbox-delivery-api | harrisonfamily | github_pr_deploy |
| W2 | hfy-record-subs-api | harrisonfamily | github_pr_deploy |
| W2 | hfy-contrib-ledger | harrisonfamily | github_pr_deploy |
| W2 | hfy-contrib-read-api | harrisonfamily | github_pr_deploy |
| W2 | hfy-comments-photos-desc-api | harrisonfamily | github_pr_deploy |
| W2 | hfy-moderation-api-core | harrisonfamily | github_pr_deploy |
| W2 | hfy-moderation-ask-api | harrisonfamily | github_pr_deploy |
| W3 | hfy-inbox-ui | harrisonfamily | github_pr_deploy |
| W3 | hfy-follow-ui | harrisonfamily | github_pr_deploy |
| W3 | hfy-comment-photos-ui | harrisonfamily | github_pr_deploy |
| W3 | hfy-person-sections-capped | harrisonfamily | github_pr_deploy |
| W3 | hfy-person-contrib-ui | harrisonfamily | github_pr_deploy |
| W3 | hfy-feed-contrib-line | harrisonfamily | github_pr_deploy |
| W3 | hfy-moderation-ui | harrisonfamily | github_pr_deploy |
| W3 | hfy-moderation-queue-page | harrisonfamily | github_pr_deploy |
| W4 | hfy-proposal-notify-contrib | harrisonfamily | github_pr_deploy |
| W4 | hfy-record-change-fanout | harrisonfamily | github_pr_deploy |
| W4 | hfy-graduate-api | harrisonfamily | github_pr_deploy |
| W4 | hfy-graduate-ui | harrisonfamily | github_pr_deploy |
| W4 | hfy-moderation-record-targets | harrisonfamily | github_pr_deploy |
| W5 | hfy-social-docs | harrisonfamily | github_pr_deploy |
| W5 | hfy-social-flip-1 | harrisonfamily | github_pr_deploy |
| W6 | hfy-social-flip-2 | harrisonfamily | github_pr_deploy |
