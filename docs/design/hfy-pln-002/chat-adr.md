# ADR: webchat research intake, locked transport and Gmail fidelity values (HFY-PLN-002, chat)

| field | value |
|---|---|
| Task | HFY-TSK-219 (`chat-research-intake`), wave W0, `no_code`, component `comp-hfy-docs` |
| Plan | HFY-PLN-002 |
| Requirements | R-33, R-41 (the register touches R-33 to R-41) |
| Research | DOC-926937A24A07, io's chat research |
| Verification | DOC-363B23B01410. Chat: 67 claims, 47 verified, 18 corrected, 0 refuted, 2 unverifiable |
| Other sources | chat.md (domain design); BRD2 section 1.3, D2-26, 6.6, 11.5 and Appendix C; decision sheet DOC-C31D9E3DD932 (`decisions-for-io.md`); io's intent DOC-2CFAE07B546C; io-kit `docs/explanation/realtime-and-feeds.md` (L-09) |
| Docstore links (for `documents.put`) | `related_items`: HFY-PLN-002, HFY-TSK-219, DOC-926937A24A07, DOC-363B23B01410, DOC-C31D9E3DD932, DOC-2CFAE07B546C. `source_record_id`: HFY-TSK-219. The orchestrator sets `document_subtype` to the governance dictionary's decision/ADR value. |
| Research prompt | harrisonfamily `docs/drafts/chat-research-prompt.md` (an untracked draft, run by io in claude.ai) |
| Status | **Proposed, for io's approval.** The transport (section 3) is **LOCKED** and is not part of that approval. Q4 (CHAT-D5) and Q10 (Gmail habits) are open io choices, and the four CHAT-D10 readings await io's confirmation at UAT (section 7). |
| Date | 2026-10-13 |

Privacy: this document holds no real person name, family date, gramps_id or contact detail. Conversation ids and names appear only as placeholders (`{name}`, `{a}`, `{b}`).

## AC map

| AC of `chat-research-intake` | Satisfied by |
|---|---|
| AC1. ADR linked to HFY-PLN-002, DOC-926937A24A07 and DOC-363B23B01410; each research item adopted, deviated (reason from chat.md 3.2) or optional/never (3.3); corrected values of DOC-363B23B01410 section 2 items 7-13 | Header (links); section 4 (item register, 134 items; deviations in 4.9; optional/never in 4.10); section 5 (items 7-13 in 5.1, and every other corrected or unverifiable chat claim in 5.2). **Condition:** AC1 is met only once follow-ups F-03 (rows D6-D16 into chat.md §3.2) and F-04 (RI-18 into §3.3) land, because the reasons for D6-D16 and the new optional item RI-18 exist today only in this ADR. Both are applied before io approves this ADR. "Not taken" rows (section 4.1) carry no build item and sit outside AC1's three classes. |
| AC2. Transport recorded verbatim as locked, never re-asked; Workers Paid and the zone facts; the CHAT-D5 slot | Section 3 |
| AC3. Fidelity value sheet tagging every chat.md section 15 value [S], [I] or [DS] from DOC-363B23B01410 section 3 I | Section 6 (78 rows, with a tag check against the AC list in 6.3) |
| AC4. The L-09 amendment text, drafted for `chat-kit-protocol` | Section 8 |
| AC5. Cost note: about $5-7 a month in total on Workers Paid; the full-price items; whole-unit overage; nothing may block hibernation | Section 9 |

---

## 1. Context

io asked for webchat that "obsessively" imitates the original, pre-Google+ Gmail Chat, built first as an io-kit package. In io's words: "simple/basic is always better", "NO BELLS AND WHISTLEs", and "stability, low latency, and simple intuitive UX are the priorities" (DOC-2CFAE07B546C). The rules R-33 to R-41 are fixed: text and emoji only, a 30-day view with server retention, direct and group chats, presence, group rules, direct-chat pacing and typing indicators.

io's research (DOC-926937A24A07) recommends Cloudflare Durable Objects with WebSocket Hibernation and gives a Gmail Chat dossier. The verification (DOC-363B23B01410) confirms the top-level choice. It corrects the cost model, the Durable Object implementation rules, the push path, the iOS push rules and several Gmail values. chat.md section 3 took the research in before the verification arrived. This ADR completes the intake against the verified values.

## 2. Decision summary

1. **Transport: LOCKED by io** (section 3). Cloudflare Workers plus Durable Objects with WebSocket Hibernation, on same-host Worker routes. API Gateway WebSocket is the contingency only.
2. **Topology.** One `ChatHub` Durable Object per stack (CHAT-D3), not the research's three object kinds. The verification strengthens this choice: one hub has no full-price object-to-object RPCs and no presence rebuild (section 4.9, deviation D1).
3. **Verified Durable Object rules are binding** (section 5.1, items 8 and 9): SQLite-backed classes, hibernatable sockets with attachments, storage alarms instead of timers, an auto-response ping, presence in SQLite, and the pacing block with no awaited I/O.
4. **Push.** The push goes through a service-authenticated `/api/chat/push` route and is drained from a SQLite outbox by an alarm. The ack never waits on it. Every push shows a notification, with no silent pushes (items 10 and 11).
5. **Gmail fidelity.** The verified original behaviours are the default (Q2-16). Values the verification did not confirm ship marked [I], and io keeps or cuts each one at UAT. The sheet in section 6 carries the corrected values: moles 225-229 px wide that grow with content, no Send button, the "Sent at 2:07 am on Wednesday" form, a 9 px presence ball, and yellow for idle.
6. **Cost.** About $5-7 a month in total on Workers Paid. The $5 is the subscription the account already pays (section 9).
7. **L-09.** A dated note scopes an exception to `@io-kit/chat` only (section 8).

---

## 3. Locked decision: the chat transport (AC2)

> **LOCKED (CHAT-D1, HFY-R77).** io, 2026-10-13, verbatim: **"chat on cloudflare"**

**What it means.** `@io-kit/chat` on harrisonfamily runs on Cloudflare Workers plus Durable Objects with WebSocket Hibernation, per DOC-926937A24A07:
- One `ChatHub` object per stack (CHAT-D3).
- The same-host Worker routes `harrisonfamily.us/chat/ws*` and `harrisonfamily.us/chat/v1/*`, ahead of CloudFront. Every other path keeps reaching CloudFront unchanged.
- AWS API Gateway WebSocket, the research's runner-up, is not used. It stays the documented contingency (chat.md 4.2, option C), and its tasks are not filed.

**Locked, not asked.** The transport is not an io question:
- No handoff, sheet item, gate or task puts it to io again.
- The decision sheet lists it at its foot as "Settled: chat on Cloudflare", and `io-policy-decisions` does not ask it (BRD2 section 2.2).
- A future change of transport would be a new io ruling, not a reopening of this one.

**Recorded facts** (verified 2026-10-13):

| fact | value | why it matters |
|---|---|---|
| Cloudflare plan | io's account already has an active **Workers Paid** subscription. The account runs 4 other Workers, none chat-related. | Chat **requires** Workers Paid. Workers Free caps Durable Object requests at 100k a day and returns errors past that, resetting at 00:00 UTC (DOC-363B23B01410 F6). Free also limits Workers to 100k requests a day and 10 ms CPU per invocation (section 4.4). The requirement rests on io's ruling (chat on Cloudflare, on an account that already pays for Workers Paid), the verification's decision ("Workers Paid is required, not optional", item 7) and the hard errors past any daily cap. The verification says chat "would likely fail mid-day once everyone uses it" (item 7); section 4.4 says fan-out "will exceed these limits", for the research's three-object stack. This ADR's one-hub estimate (section 9, about 17k requests a day) sits below Free's cap, but a runaway client loop (chat.md §23) or clients stuck in a reconnect loop after a deploy could hit any cap and turn into an outage. CHAT-D2 is resolved with no billing gate. |
| Zone | `harrisonfamily.us` is on the **Free** Website plan, proxied, with **no Worker routes** | The chat routes are the zone's first Worker routes. `chat-cf-spike` proves coexistence with the CloudFront proxy and leaves the route list empty again. Worker routes work on every zone plan (chat.md 4.2). |

**Deploy access (planned, not yet in place).** A CI token (Workers Scripts:Edit only, 90-day TTL) will be created and stored under io's go-ahead at gate G-cf-token (`hfy-chat-worker-ci`). The two chat routes are created once with a separate short-lived token, and CI only verifies them. Deploys use the `@io-kit/ci` `cloudflare-worker` target (CHAT-D18 as amended by BRD2 11.5).

**What the decision brings** (chat.md section 2 and BRD2 section 1.3): the L-09 dated note (section 8); one exception to D-10 and edge-and-origin-design ("one CloudFront distribution fronts everything") for the two chat routes; no new DNS name or certificate.

**CHAT-D5, "what online means" (Q2-08, sheet item Q4).** This is an io question. It is not locked, and it is recorded here once answered.

| item | value |
|---|---|
| Default on the sheet (Q4) | "online while the site is open on any device (idle counts), plus 20 seconds; locked phones drop off, so phone-to-phone chats often pause. No invisible mode; chat shows who has an account." |
| io's answer | **Pending.** Recorded here verbatim, with its date, once `io-policy-decisions` records it through gate `q2-08-chat-online`. `chat-kit-server-core` and `hfy-chat-uat` wait on that gate, not on this ADR. |

**Not in this ADR.** Q9 (the family-tree approach) is a visualization question. Q9 is open; the viz ADR (`viz-research-intake`) carries its slot and records io's answer once `io-policy-decisions` records it. Nothing here depends on it.

---

## 4. Research item register (AC1)

### 4.1 How to read it

Every item in DOC-926937A24A07 is listed once, in the report's order. Each gets one status:

| status | meaning |
|---|---|
| **Adopted** | Built as the research says |
| **Adopted, corrected** | Built, with the verified correction from section 5 applied |
| **Deviated** | Built differently. The reason is chat.md section 3.2 (rows D1-D5 in 4.9), or, where 3.2 has no row, the reason given here (rows D6-D16, proposed as new 3.2 rows) |
| **Optional (off)** | Not built in v1; needs a new io decision (chat.md section 3.3, plus one item this ADR adds) |
| **Never** | Not offered, because it conflicts with io's rules (chat.md section 3.3 or R-34) |
| **Not taken** | Covers compared alternatives, the contingency (option C) and history rows. These carry no build item, so they sit outside AC1's adopted, deviated and optional/never classes: there is nothing to build, deviate from or switch on. |

References: "§" is a chat.md section. CHAT-Dn is a chat.md decision. Fn, Gn, Hn and In are DOC-363B23B01410 claim ids.

### 4.2 Part 1A: Gmail Chat feature inventory

| # | research item | status | where / reason |
|---|---|---|---|
| RI-01 | Chat inside the web app, nothing to download | Adopted | The chat island loads on every page under `chatV1` (§15.1, §17) |
| RI-02 | Google Talk as an XMPP client with federation | Not taken (history) | No XMPP, no federation, no third-party clients. Protocol v1 is JSON over one WebSocket (§6), the research's own modern mapping. |
| RI-03 | Chat history saved like email and searchable under "Chats" | Deviated (D6) + Optional (off) | Stored indefinitely, visible for 30 days (R-35, CHAT-D9). History search is optional and off (§3.3). |
| RI-04 | Off the record | Never | §3.3: it contradicts R-35 ("stored on server") |
| RI-05 | Quick Contacts: the chat list synced with the Talk friends list | Deviated (D7) | The roster is the family allowlist directory (CHAT-D16), with labels that are never emails (HFY-R68) |
| RI-06 | Docked pop-up: admin area bottom left, chat box bottom right | Adopted | §15.1, CHAT-D13. The bottom-right dock is verified (I19); the bottom-left panel is [I] (section 6). |
| RI-07 | Offline messages delivered at the next sign-in as unread inbox mail | Deviated (D8) | Delivered at the next connect as unread: a bold roster row and the entry dot. No email inbox (§13). Optional content-free web push is a per-user setting that defaults off (Q10; CHAT-D12 as amended by BRD2 11.5). |
| RI-08 | Orkut chat; AIM buddies in Gmail | Never | Other networks; R-41 |
| RI-09 | Group chat started from the Options menu of a 1:1 window | Deviated (D9) | "new group" in the roster, and "add people" in a DM, both create a **new** named group, and the DM's history never carries over (R-38, CHAT-D10). The research's final synthesis says the same. |
| RI-10 | Rich emoticons: a smiley picker; typed shortcuts still convert | Adopted | §12.1. Typed conversion is [S] (FV-76): the post verified under I2 is the source the research quotes for typed-shortcut conversion (DOC-926937A24A07 Part 1A). |
| RI-11 | Invisible mode | Never | §3.3: it breaks R-39 pacing |
| RI-12 | The "mole" sticky-note design; no Send button | Adopted, corrected | Item 13: no Send button on any device, with hint text instead (Q10 default) |
| RI-13 | Gmail Labs | Not taken (history) | — |
| RI-14 | SMS chat | Never | R-41. No phone numbers are kept (R-18). |
| RI-15 | Voice and video chat, with pop-out and fullscreen | Never | R-34 (text and emoji only). Pop-out alone is adopted, under RI-30. |
| RI-16 | The 2013 chat-history UI; Hangouts replacing Talk | Not taken (history) | io's target is the pre-Google+ Gmail Chat |

### 4.3 Part 1B: UX recreation spec

| # | research item | status | where / reason |
|---|---|---|---|
| RI-17 | Contacts built automatically from frequent contacts; "only people I've approved" as the alternative | Deviated (D7) | Every eligible member is reachable by search (R-36). The list shows people online first, then your own recent contacts (§15.1, CHAT-D15). There is no approval step, because the family allowlist is the approval. |
| RI-18 | "Always show" / "Never show" per contact | Optional (off) | Not in §3.3. **Added by this ADR**; it needs a new io decision (R-41) |
| RI-19 | Ordering: online first, then pinned, then by frequency [inferred] | Deviated (D10) | Online first (active, idle, alphabetical), then your recent conversations by recency, capped at 40, with no pinning. "Recent" uses only your own conversations, so no ranking reveals who talks to whom (§15.1). Pinning is an extra (R-41). |
| RI-20 | A search box above the list, search-to-chat | Adopted | §15.1, R-36 |
| RI-21 | Contact count shown [unknown] | Adopted [I] | 40 rows (§15.1). chat.md cites a Gmail 40-contact cap, but neither the research nor the verification sources it (section 6, FV-11). |
| RI-22 | Available: a green ball, the default | Adopted | §10.1 (I7) |
| RI-23 | Busy: red, manual | Optional (off) | §3.3 |
| RI-24 | Idle: automatic after 15 min, cannot be chosen | Adopted | §10.1 (I7). The "or tab hidden" part is deviation D2. The idle hue is yellow, per I7 (FV-70). |
| RI-25 | Offline: a grey ball | Adopted | A grey hollow ring: shape plus text, never colour alone [DS] |
| RI-26 | Invisible | Never | §3.3 |
| RI-27 | Mobile presence icon | Optional (off) | §3.3 |
| RI-28 | Free-text status messages | Optional (off) | §3.3 ("custom status message") |
| RI-29 | Shared status across all of a user's clients; idle per client | Adopted | User state is the strongest state across that user's sockets (§10.2) |
| RI-30 | Moles docked bottom right, side by side right to left; title bar with name, ball, minimise, pop-out and close | Adopted | §15.1. Pop-out, minimise and close are [I] (section 6). To fit 44 px targets into the 229 px mole, minimise becomes the title-bar toggle rather than a separate glyph (FV-20, FV-24). |
| RI-31 | Single-line input that grows; Enter sends; a Send hint | Adopted | §12.1 (grows to 4 lines). The hint is the Gmail fix (item 13). |
| RI-32 | Mole size about 225-260 × 300-350 px [inferred] | Adopted, corrected | I13 and I14: 225-229 px wide; the height grows with content (FV-16, FV-17) |
| RI-33 | New-message alert: the title bar flashes; the tab title alternates [inferred] | Adopted | Q10 default on. The orange title bar is [S] (I15); flashing and tab-title alternation are [I]. |
| RI-34 | Sounds (an on/off setting) | Optional (off) | §3.3: R-41 ("no bells") wins |
| RI-35 | Messages grouped by sender | Adopted | §15.1 runs: the name in bold once, then indented lines (I12) |
| RI-36 | Timestamps omitted within the "same" 1, 2 or 5 minutes | Adopted | A fixed 5-minute threshold (I9, I10). The adaptive threshold is optional and off (§3.3). |
| RI-37 | A break line that shows the length of a pause ("Sent at …") | Adopted, corrected | I11 verifies the form "Sent at 2:07 am on Wednesday", lowercased for the design-system voice (D3; FV-37) |
| RI-38 | A "chat session" runs from opening the window to closing it | Deviated (D11) | Conversations persist across pages and visits (R-35, §6.6). Pauses are marked only by the "sent at" line. |
| RI-39 | "{name} is typing…" while keys are pressed | Adopted | §11 (I17) |
| RI-40 | "{name} has entered text" when typing stops with text in the box (5 s) | Adopted [I] | §11. I18 is unverifiable, so this item can be cut at UAT (Q10). |
| RI-41 | Grey italic system lines: "off the record", "{name} is offline. You can still send…", "{name} did not receive your chat" | Adopted (style, offline line) / Never / Deviated (D12) | The style and the offline line are adopted (§15.5, in design-system voice). System lines are verified (I3); the grey italic style is not, so it is [I] (FV-41). "Off the record" is never offered. "Did not receive" is replaced by "not sent. tap to retry.", because every message is stored and acked (§6.3). |
| RI-42 | Group rooms have no names; the title lists the participants [inferred] | Deviated (D13) | The creator names the group (R-38). An unnamed group uses the verified title form "({n}) {a},{b},{c}" (I3; FV-22). Renaming after creation is a CHAT-D10 interpretation that io confirms at `hfy-chat-uat` (AC5; section 7.3). |
| RI-43 | Anyone leaves by closing the window [inferred] | Deviated (D14) | Closing a mole is not leaving. Leaving is explicit, and coming back needs an invite (R-38, §8.2). That direct chats cannot be left is a CHAT-D10 interpretation that io confirms at `hfy-chat-uat` (AC5; section 7.3). |
| RI-44 | Late joiners see only new messages [inferred] | Adopted | R-38; membership epochs (§7.1) |
| RI-45 | A message to an offline contact is stored and delivered at the next sign-in | Adopted | Stored, acked and resumed. Delivery is as in RI-07. |

### 4.4 Part 1C and 1D: architecture, and what made it feel great

| # | research item | status | where / reason |
|---|---|---|---|
| RI-46 | XEP-0085 chat states (active, composing, paused, inactive, gone) as the typing model | Adopted (semantics) | The frame states are `on`, `paused` and `off` (§11). The XMPP protocol itself is not used. |
| RI-47 | BrowserChannel forward and back channels, array acks, resending pending maps | Adopted (mapping) | One WebSocket with `cmid`/`seq` acks, an outbox resend and `hello` resume (§6) |
| RI-48 | Chats stored and indexed like email | Deviated (D6) | Hub SQLite plus a DynamoDB archive mirror, with no index or search (CHAT-D9, §3.3) |
| RI-49 | Zero setup: the contact list is built for you | Adopted | The directory comes from the allowlist (CHAT-D16) |
| RI-50 | Always-on windows | Adopted | Moles on every page, and pop-out for the multi-page site (§15.1) |
| RI-51 | Enter to send, with no compose ceremony | Adopted | §12.1 |
| RI-52 | Sparse timestamps with gap separators | Adopted | §15.1 |
| RI-53 | Three-colour presence plus automatic idle after 15 min | Adopted | Green, yellow (idle) and grey. Busy (red) is optional and off. |
| RI-54 | "is typing…" | Adopted | §11 |
| RI-55 | Nothing lost: offline messages arrive; history searchable like mail | Adopted (nothing lost) / Optional (off) (search) | Store, ack and resume. The view is limited to 30 days (R-35). |
| RI-56 | One connection in every browser | Adopted | One socket per page (§6.6). WebSocket only: full RFC 6455 support from iOS 6 (H10). |
| RI-57 | What users lost with Hangouts: invisible, XMPP clients, status messages, simple colours | Adopted (colours) / Never (invisible) / Optional (off) (status) / Not taken (XMPP) | — |

### 4.5 Part 2A and 2B: modern products and building blocks

| # | research item | status | where / reason |
|---|---|---|---|
| RI-58 | Pattern: one stateful owner per conversation plus a per-user process (Slack, Discord) | Deviated (D1) | One `ChatHub` per stack (CHAT-D3). The research topology is the scale-out path (§5.3). |
| RI-59 | Presence only for users visible on screen (Slack) | Deviated (D15) | Family-scoped presence: every eligible member sees every other (CHAT-D15). R-37 asks for presence on profiles, in the family list and in every chat, and family scale makes it cheap. |
| RI-60 | The Phoenix lesson: never route or persist on presence | Adopted | Presence never decides storage or push (§13) |
| RI-61 | The WhatsApp, Signal, iMessage, Telegram, Google Chat, Teams, Matrix, XMPP-server and Zulip rows ([unverified]) | Not taken (context) | Comparison only |
| RI-62 | **Cloudflare Durable Objects + WebSocket Hibernation (fit 5)** | **Adopted. LOCKED** | io, 2026-10-13, "chat on cloudflare" (section 3) |
| RI-63 | PartyKit on Durable Objects (fit 4) | Not taken | An abstraction layer over the same objects (R-41) |
| RI-64 | AWS API Gateway WebSocket + Lambda + DynamoDB (fit 4, runner-up) | Not taken (contingency C) | chat.md 4.2. Its tasks are not filed. Its cost wording is corrected by item 12. |
| RI-65 | AppSync Events (fit 3) | Not taken | Option B was rejected (chat.md 4.2): a credential in page JavaScript, a new host, heartbeat presence and a fetch per message. G15: it cannot use the HttpOnly cookie. |
| RI-66 | IoT Core MQTT over WSS (fit 2) | Not taken | Awkward for the web (research) |
| RI-67 | Ably, Pusher, PubNub (fit 3-4) | Not taken | Vendor lock-in, and a further processor of family messages |
| RI-68 | Stream Chat, Liveblocks (fit 2) | Not taken | High lock-in, and hard to make look like Gmail |
| RI-69 | Self-hosted Centrifugo, NATS or Phoenix (fit 3) | Not taken | Servers to run (R-41) |
| RI-70 | Raw transports: WebSocket; SSE+POST as a fallback; WebTransport | Adopted (WebSocket) / Not taken (SSE, WebTransport) | WebSocket is supported on every target (H10). There is no fallback transport (R-41). |
| RI-71 | iOS 16.4+ Web Push for Home Screen web apps, through APNs | Adopted | §13 (H1, H2). Since Safari 26, any site added to the Home Screen opens as a web app. |
| RI-72 | Push permission requested on direct user interaction | Adopted | `subscribe` is called synchronously in the tap handler (H3). The notifications domain owns the prompt. |
| RI-73 | No Background Sync or Periodic Background Sync on iOS | Adopted (constraint) | The outbox flushes on foreground (`chat-kit-client` AC; H8, H9) |
| RI-74 | Declarative Web Push on iOS and iPadOS 18.4, needing no service worker | Adopted, corrected | Item 11: every push shows a notification (H4, H5, H6) |
| RI-75 | The socket closes whenever the PWA is backgrounded [inferred] | Adopted [I] | H7 is unverifiable. The mobile client closes on `hidden` and sends `hello`/`ping` on `visible` (§10.2, `chat-kit-client` AC). |

### 4.6 Part 2C: reliability engineering

| # | research item | status | where / reason |
|---|---|---|---|
| RI-76 | A client `cmid` (ULID); the object keeps `cmid → seq` for 24 h | Adopted (strengthened) | The unique index `(conv, from_uid, cmid)` lives as long as the row (§6.3). A retry after 24 h is still exactly-once. |
| RI-77 | A gap-free `seq` per conversation, assigned single-threaded, written before the ack | Adopted, corrected | F14: no awaited I/O between the pacing check, the `seq` assignment and the INSERT; the ack follows the commit (§6.3, `chat-kit-server-core` AC) |
| RI-78 | A client outbox resends unacked frames on reconnect | Adopted | At most one queued message per conversation while disconnected, so the outbox never queues a run that pacing would reject (§9). It is stored in IndexedDB and flushed on foreground (`chat-kit-client` AC). |
| RI-79 | At-least-once delivery with dedupe by `seq`; push payloads carry `conv` and `seq` only | Adopted / Adopted, corrected | Dedupe by `(conv, seq)`. Push: item 11 (a title and navigate URL are required; `conv` and `seq` are only for dedupe). |
| RI-80 | Gap detection: `seq` past `lastSeq + 1` triggers a fetch | Adopted | `page {after}` (§6.3) |
| RI-81 | Connection-bound presence; state = max(active > idle > offline) across sockets | Adopted | §10.2 |
| RI-82 | Idle = 15 min without input **or tab hidden** | Deviated (D2) | — |
| RI-83 | A 20 s grace before announcing offline | Adopted, corrected | A storage alarm, never `setTimeout` (item 8) |
| RI-84 | App ping every 25 s; a socket silent for 60 s is dead | Adopted, corrected | `setWebSocketAutoResponse` for ping (F9). A liveness sweep by alarm uses `getWebSocketAutoResponseTimestamp`: 60 s while visible, 150 s while hidden (§10.2; item 8). |
| RI-85 | Never use presence to decide whether to persist | Adopted | §13 |
| RI-86 | Typing: `on` at the first keystroke, refreshed at most every 3 s, `paused` after 5 s, `off` on send or clear; receivers expire after 7 s; never stored | Adopted [I timings] | §11. Expiry runs in the receiver, not the hub, so the hub has no timer and no alarm for typing (item 8). This departs from BRD2 11.5's wording, which lists typing expiry among the storage alarms; the reason is in item 8, and follow-up F-15 aligns BRD2. |
| RI-87 | Pacing checked in the conversation object; `online(peer)` read from the peer's User object cache | Adopted (rule) / Deviated (D1) (location) | The rule is unchanged. One hub checks it in one synchronous section, with no cross-object cache and no lag (§9). |
| RI-88 | Never delete; the view query is `seq >= join_seq AND ts >= now − 30d` | Adopted | Extended with `left_seq`, so the visible set is the union of epochs (CHAT-D11, §7.1) |
| RI-89 | An optional nightly export to S3 | Deviated (D4) | — |
| RI-90 | Late joiners and rejoins as epochs `(join_seq, left_seq)` | Adopted | §7.1, §8.2 |

### 4.7 Part 2D: reference architecture

| # | research item | status | where / reason |
|---|---|---|---|
| RI-91 | Same-origin `wss://…/chat/ws` through the Cloudflare proxy; a Worker verifies the RS256 cookie and routes | Adopted | §6.5 (F15, F16). Open: confirm that the `io_id` cookie's Path covers `/chat` (`chat-cf-spike` AC1). |
| RI-92 | Three object kinds: a User object, a Conversation object and a Family Presence object | Deviated (D1) | The rules of item 9 apply to the one hub |
| RI-93 | Offline recipients through a queue or HTTP to the existing AWS web-push service | Adopted, corrected | Item 10: the service-authenticated `/api/chat/push` through CloudFront, drained from the SQLite `push_outbox` by an alarm. The ack never waits. |
| RI-94 | A nightly export to S3 | Deviated (D4) | — |
| RI-95 | Wire frames: `hello` with `resume`, `send`, `ack`, `msg`, `err`, `typing`, `presence`, `ping`/`pong` | Adopted | §6. The presence frame's `status` and `mobile` fields are dropped (§3.3). Frames are added for groups, reads, paging and `reauth`. |
| RI-96 | Conversation SQLite tables `meta`, `members` and `messages` | Adopted | In the hub's SQLite (§7.1) |
| RI-97 | User object state "in memory + KV storage" | Adopted, corrected | Item 9 and F19: a SQLite-backed class, with socket attachments |
| RI-98 | Family Presence "in memory, rebuilt from User objects on wake" | Adopted, corrected | Item 9 and F20: the `presence` table in SQLite, with a cold-start grace (§10.2) |
| RI-99 | An optional DynamoDB mirror for admin and search, with no TTL | Adopted | The archive mirror (CHAT-D9, §7.2). The UI never queries it, and it has no search. |
| RI-100 | Reconnect flow: `hello` with the last seq; replay capped at 200, then paginated; reconnect on `visibilitychange`; backoff 0.5 s to 30 s with jitter | Adopted | §6.4 |
| RI-101 | Failure modes: eviction, duplicate send, lost push, clock skew | Adopted | §20.5 |
| RI-102 | Cloudflare outage: show "Reconnecting…", and keep queued sends in an IndexedDB outbox | Adopted | "reconnecting…" after 2 s (§6.4). For the outbox, see RI-78. |
| RI-103 | Latency budget: p50 150 ms, p99 500 ms, with per-hop targets | Adopted | §20.1 and §20.2. One hub removes the object-to-object hop. The hop figures are unverifiable from docs (F12) and are measured. |
| RI-104 | Monthly cost about $5 | Adopted, corrected | Item 7 and the cost note (section 9) |
| RI-105 | Runner-up: conditional `UpdateItem` for `seq` and a transactional write for pacing | Not taken (contingency C) | `DynamoStore.append` as one `TransactWriteItems` (§7.4). Its cost is corrected by item 12. |

### 4.8 Part 2E, final synthesis, assumptions

| # | research item | status | where / reason |
|---|---|---|---|
| RI-106 | Protocol unit tests: duplicate `cmid`, out-of-order acks, gap fill, the pacing matrix, late-join epochs | Adopted | CH-01 to CH-32 (§19.1, BRD2 11.5) |
| RI-107 | Chaos: kill sockets, drop 10 %, duplicates, object restarts, ±10 min skew | Adopted | §19.2, L4 |
| RI-108 | Load: 500 clients, 20 groups of 30, 5 typing at once, p99 under 500 ms | Adopted | §20.3. Note: chat.md §3.1 records 500 clients, but L1 runs 300. Follow-up F-11 asks `hfy-chat-load-latency` to run L1 at 500, keeping the research's headroom, or to record why not. |
| RI-109 | Real iPhones: 3 iOS versions, PWA and Safari, backgrounding, airplane mode, Wi-Fi to LTE, push and catch-up | Adopted | §20.4 |
| RI-110 | A latency SLO beacon to an endpoint, reported weekly | Deviated (D16) | No new telemetry endpoint. The SLOs are measured by the load harness on staging, and on devices by a client-only debug overlay (`?hfy_chat_debug=1`, §20.4). This adds no data-collection path (R-41, privacy posture). |
| RI-111 | A 72 h soak | Adopted | L5 (24 h minimum if the budget forces it) |
| RI-112 | Detail 1: your message renders at once in grey and darkens on `ack` | Adopted | §15.1 |
| RI-113 | Detail 2: Enter sends, Shift+Enter adds a newline, **label the Send button** | Adopted (keys) / Adopted, corrected (button) | Item 13: no Send button; `enterkeyhint="send"` on phones (Q10 default) |
| RI-114 | Detail 3: bottom-docked windows on desktop, a full-screen sheet on iPhone | Adopted | §15.1, §15.4 |
| RI-115 | Detail 4: green, orange and grey dots, an idle clock glyph, the 15-minute rule | Adopted, corrected | I7: the idle hue is **yellow** (FV-70) |
| RI-116 | Detail 5: timestamps after gaps of more than 5 min, "Sent at 3:42 PM on Tuesday" | Adopted, corrected | I11 (FV-37) |
| RI-117 | Detail 6: one, two and several people typing or with entered text | Adopted | §11, lowercase |
| RI-118 | Detail 7: reconnect on `visibilitychange`; show nothing unless it takes more than 2 s | Adopted | §6.4 |
| RI-119 | Detail 8: the pacing rule explained inline, with the input disabled rather than a pop-up | Adopted | §9 |
| RI-120 | Detail 9: family list online first, then frequent contacts, search at the top | Adopted | Recent rather than frequent (D10) |
| RI-121 | Detail 10: grey italic system lines for joined, left and offline | Adopted | §15.1 |
| RI-122 | Risk 1: iOS kills sockets → Web Push plus `resume(since)` | Adopted | §13, §6.4 |
| RI-123 | Risk 2: push not enabled → an install prompt and an in-app unread badge | Adopted (in part) | In-app unread: the entry dot and bold roster rows. The install and permission prompt belongs to the notifications domain. Chat sets no app badge (§3.3). |
| RI-124 | Risk 3: duplicates or lost messages → `cmid`, `seq` gap fill, outbox | Adopted | §6.3 |
| RI-125 | Risk 4: pacing race → enforce in the single-threaded object | Adopted | Stronger in one hub (§9) |
| RI-126 | Risk 5: presence flapping → a 20 s grace | Adopted | §10.2 |
| RI-127 | Risk 6: stale typing → a 7 s receiver expiry | Adopted | §11 |
| RI-128 | Risk 7: late-join leaks → epoch-bounded queries on the server | Adopted | §7.1 |
| RI-129 | Risk 8: cookie not sent on the WebSocket → keep the same origin; fall back to a short-lived ticket | Adopted (same origin) / Deviated (D5) (ticket) | — |
| RI-130 | Risk 9: lock-in → exportable messages and a transport-agnostic protocol | Adopted | DynamoDB archive (D4), `ChatTransport` and `ChatStore` (§16), contingency C |
| RI-131 | Risk 10: older users confused → no reactions or attachments, large tap targets, plain-language system lines | Adopted | R-34, 44 px targets [DS], design-system voice |
| RI-132 | Assumption: about 300 members, at most about 60 online, 50 messages per active user per day | Adopted (load model) | The load tests use it. The cost model uses about 40 active members (§5.3). |
| RI-133 | Assumption: the session cookie is sent on the same-origin upgrade [inferred] | Adopted, verified | F16. The Path check stays open (RI-91). |
| RI-134 | Assumption: "online" = at least one live foreground connection | Deviated, pending io | The CHAT-D5 default: idle counts, desktop tabs stay connected while hidden, plus a 20 s grace. io's Q4 answer is pending (section 3). |

### 4.9 Deviations, with reasons

**Rows D1-D5 are chat.md section 3.2, with their reasons re-checked against the verification:**

| id | research says | design | reason (chat.md 3.2), and what the verification changes |
|---|---|---|---|
| D1 | Three object kinds: per conversation, per user, family presence | One `ChatHub` per stack (CHAT-D3) | One object at family scale is far below its limits. It reads presence and conversation state in one synchronous section, removes a hop and leaves one SQLite file. **The verification strengthens this:** object-to-object RPCs and fan-out RPCs are full-price requests (item 7), and the research's presence rebuild would be about 300 full-price RPCs (F20); one hub has neither. **Correction to the reason:** 128 MB is per isolate, and each object is billed as 128 MB (F10). 32,768 sockets per object and about 1k requests/s are verified (F7, F11). |
| D2 | Idle = 15 min without input **or tab hidden** | Idle means 15 min without input only. A hidden mobile page closes its socket (then the 20 s grace, then offline). A hidden desktop tab stays connected. | Gmail's rule is "automatic after 15 minutes away", and a hidden desktop tab would turn most members idle all the time. **Verified:** the 15-minute rule dates from launch, primary source the 2006 help page (I7). |
| D3 | "Sent at 3:42 PM on Tuesday" | `sent at 2:07 am on wednesday` form | The design-system voice uses lowercase (HFY-R13). **Changed:** chat.md said the exact string was "unverified either way"; I11 now verifies "Sent at 2:07 am on Wednesday". am/pm was already lowercase in Gmail, so the only deviation left is the capital S and the capital weekday. |
| D4 | An optional nightly export to S3 | An archive mirror into DynamoDB `hfy-app`, batched every 10 min (CHAT-D9) | It keeps the retained history in the existing system of record with point-in-time recovery, needs no S3 credential in the Worker, and feeds contingency C. Unchanged. |
| D5 | On an auth failure, fall back to a short-lived ticket from the HTTP API | No ticket; WebSocket close codes 4401 and 4403 (§6.5) | A browser cannot read the status of a failed upgrade, and a ticket would put a credential in page JavaScript. Unchanged (F16: the cookie is sent). |

**Rows D6-D16 are deviations chat.md makes elsewhere without a 3.2 row. The reason is given here, and each is proposed as a new 3.2 row (follow-up F-03):**

| id | research item | design | reason |
|---|---|---|---|
| D6 | History saved and indexed like email (RI-03, RI-48) | Hub SQLite plus an archive, a 30-day view, no search | R-35 (a 30-day view, kept on the server); history search is optional (§3.3) |
| D7 | Contacts from Quick Contacts, or from frequent contacts with an approval option (RI-05, RI-17) | The family allowlist directory; everyone reachable by search | R-36 (anyone can start a chat by search), family scope, HFY-R68 (labels never emails) |
| D8 | Offline messages delivered to the email inbox (RI-07) | Unread state at the next connect; a content-free per-user web push that defaults off | There is no email inbox; the notifications domain owns the inbox (R-13). Q10 default: phone alerts off. |
| D9 | Group chat from the Options menu, extending the 1:1 (RI-09) | A new named group; DM history never carries over | R-38 (the creator names the group; a late joiner sees only later messages) |
| D10 | Ordering by pinned and frequency (RI-19) | Online first, then your own recent conversations, cap 40 | Privacy: no ranking reveals who talks to whom (§15.1); pinning is an extra (R-41) |
| D11 | A chat session runs from opening the window to closing it (RI-38) | Persistent conversations | R-35, and the multi-page site (§6.6) |
| D12 | "{name} did not receive your chat" (RI-41) | "not sent. tap to retry." | Every message is stored before its ack (§6.3), so "not received" cannot happen after an ack |
| D13 | Unnamed rooms (RI-42) | The creator names the group; an unnamed fallback title | R-38. The creator may also rename the group after creation: a CHAT-D10 interpretation, pending io's confirmation at `hfy-chat-uat` (AC5). |
| D14 | Leave by closing the window (RI-43) | Explicit leave; return by invite. Direct chats cannot be left. | R-38. **Pending io (CHAT-D10 interpretations, `hfy-chat-uat` AC5):** "direct chats cannot be left" sits against io's words "members can choose to leave a chat at any time", and renaming after creation (D13) is also a reading. Both stay visible to io (section 7.3). |
| D15 | Presence only for visible users (RI-59) | Family-scoped presence | R-37 (profiles, family list, every chat); disclosed in the privacy amendment and covered by io's Q4 answer |
| D16 | A latency beacon endpoint (RI-110) | The load harness plus a client-only debug overlay | No new data-collection endpoint (R-41, privacy posture) |

### 4.10 Optional and never (chat.md section 3.3, plus one addition)

None of these is built in v1. An optional item needs a new io decision; a never item is not offered.

| item | status | reason |
|---|---|---|
| Busy (red) | Optional (off) | io asked only for "online status" |
| Custom status message | Optional (off) | — |
| Invisible | **Never** | It breaks R-39 pacing |
| Off the record | **Never** | It contradicts R-35 |
| Mobile presence icon | Optional (off) | — |
| Sounds | Optional (off) | R-41 ("no bells") wins over Gmail's default-on sounds |
| Block a contact | Optional (off) | Family scope; the gap is a chat.md §26 risk |
| Chat history search | Optional (off) | The roster search that R-36 needs stays |
| Read receipts, "last seen" | **Never** | Not asked for, and they add surveillance |
| Per-chat mute; an app badge from chat | Optional (off) | The notifications domain owns the badge |
| Adaptive timestamp threshold (T = 4 × the median gap) | Optional (off) | A fixed 5-minute threshold |
| "Always show" / "Never show" per contact | Optional (off) | **Added by this ADR** (RI-18) |
| Reactions, photos, GIFs, attachments, voice, video | **Never** | R-34 (io's words) |

Three Q10 items ship **off** by default but stay io's choice: auto-opening windows, changing a group's private/open policy after creation, and chat web push (section 7).

---

## 5. Corrected values from the verification (AC1)

### 5.1 DOC-363B23B01410 section 2, items 7-13 (chat)

| item | research said | corrected value | what the design does | lands in |
|---|---|---|---|---|
| **7. Cost** | About $5 a month: 1-2M incoming frames ÷ 20 is about 100k billable requests, within the 1M included | Only incoming WebSocket messages get the 20:1 discount. Reconnects, Worker-to-object and object-to-object RPCs, fan-out, presence updates and alarms are each a **full** request. The realistic total is **about $5-7 a month on Workers Paid**. Overage is billed in whole units: 1 GB-s over the included duration costs $12.50. Workers Free allows 100k object requests a day and errors past that. **Workers Paid is required, not optional.** | The cost note (section 9). chat.md §23's "about $0 extra" is replaced (BRD2 11.5). | `hfy-chat-worker-prod` (the `cost-estimate.md` line) |
| **8. Server-side timers break hibernation** | A 20 s grace and typing expiry in the object (by implication, timers) | A `setTimeout` inside an object keeps it awake and billed for duration. Use **storage alarms**, or let the client expire typing. Use WebSocket **auto-response** for ping/pong, and `getWebSocketAutoResponseTimestamp` to detect dead sockets. | Alarms for the grace, the liveness sweep and the outbox drains. Typing expiry runs in the receiver. Ping is answered by `setWebSocketAutoResponse` (§10.2, §11). **Deviation from BRD2 11.5's wording**, which lists "storage alarms for the offline grace, typing expiry and dead-socket checks": the hub has no alarm for typing. The verification allows either ("or let the client expire typing state"). The reason: a typing alarm would wake the hub every few seconds while anyone types, each wake a full-price alarm request plus awake duration, while the 7 s receiver expiry (§11) already clears stale typing. Without it the hub can hibernate between frames. The hub's own typing work is event-driven only (`off` on send and on a user's last socket close). F-15 aligns BRD2 11.5. | `chat-kit-cloudflare`, `chat-kit-server-core` |
| **9. In-memory state is lost on hibernation** | User object `sockets[]` and `last_input_ts` in memory; Family Presence in memory, "rebuilt on wake" | Track sockets with `ctx.getWebSockets(tag)` and `serializeAttachment` (16 KB maximum) plus SQLite. Persist the presence map in SQLite; a rebuild would be about 300 full-price RPCs. **Every class is SQLite-backed** (`new_sqlite_classes`); the key-value backend is closed to new accounts. | One hub: `acceptWebSocket(ws, [uid])`; attachments hold `uid`, `sid`, `exp`, `st`, `vis`, `typ` and the token buckets (asserted under 16 KiB); the `presence` table in SQLite; migration `v1` `new_sqlite_classes = ["ChatHub"]` (§7.1). | `chat-kit-cloudflare`, `hfy-chat-worker` |
| **10. An object cannot call the AWS web-push service as-is** | The object calls the existing AWS web-push service through a queue or HTTP | Push is sent in-process by the API Lambda. Every route needs the `io_id` user session, and the Function URL accepts only CloudFront's `X-Origin-Verify`. Add a **service-authenticated push endpoint** (or Cloudflare Queues). **The ack must never wait on the push.** | `POST /api/chat/push` with an ES256 service JWT, through `<site>/api/*` → CloudFront (which adds `X-Origin-Verify`). The hub writes `push_outbox` rows after commit, and an alarm drains them (§13, §14). | `hfy-chat-api-service-routes`, `chat-kit-cloudflare` |
| **11. iOS forbids silent push** | Push payloads carry `conv` and `seq` only | Every push must show a notification, or WebKit revokes the subscription. Payloads carry a **title and a navigate URL**, in Declarative Web Push format on iOS 18.4+. `conv` and `seq` are added only for dedupe. Push cannot trigger a background reconnect or sync. | The `chat_message` type: a title, the level-0 or level-1 line, navigate `/chat/?c=…`, never message text (§13). The client never reconnects from a push. | `hfy-chat-api-service-routes`, `chat-kit-client` |
| **12. The runner-up's cost depends on heartbeat cadence** | The gateway costs "cents to a few dollars" | On API Gateway, browser pings are billed data messages: a 25 s ping costs about $12 a month at 60 concurrent users. Use a 5-9 min heartbeat or a MOCK ping route; then the gateway is about $2 a month plus Lambda and DynamoDB. | Affects contingency C only. Recorded here so a future switch does not inherit the 25 s ping. | none (contingency) |
| **13. The original had no Send button** | Top-10 detail 2: "label the Send button"; moles about 225-260 × 300-350 px | Google fixed the usability problem with **hint text** ("Press enter to send your message"), not a button. The mole is **225-229 px wide**, with a **height that grows with content**. | No Send button on any device: Enter sends, `enterkeyhint="send"` on phones, and the placeholder carries the hint. chat.md §12.1's coarse-pointer button is removed (BRD2 11.5). Mole values: FV-16, FV-17. | `chat-kit-react-conversation`, `chat-kit-react-shell` |

### 5.2 Every other corrected or unverifiable chat claim (DOC-363B23B01410 section 3)

This makes the 18 corrected and 2 unverifiable chat claims complete. Items 7-13 above draw on F5, F17, F19, F20, G10, H6, I13 and I14.

| claim | research said | correct value | effect |
|---|---|---|---|
| F5 | About 100k billable requests, about $5 | Several million requests once full-price items count; about $5-7 | Item 7 |
| F10 | 128 MB per object | 128 MB per isolate, which several objects may share; each object is billed as 128 MB | D1 reason; the duration arithmetic in section 9 |
| F17 | An object can call the AWS web-push service | It is fine on Cloudflare's side, but AWS has no service-to-service endpoint | Item 10 |
| F19 | User object "in memory + KV storage" | New classes are SQLite-backed (the KV API runs on that backend); storage over 5 GB-month costs $0.20/GB-month | Item 9 |
| F20 | Family Presence in memory, "rebuilt on wake" | State is discarded after about 10 s idle; a rebuild is about 300 full-price RPCs; persist it in SQLite | Item 9 |
| G6 | $1.00 per million messages | $1.00/M for the first 1B, then $0.80/M; metered per 32 KB; ping/pong control frames free; a 12-month free tier | Contingency only |
| G9 | Price source: a third-party price site | Not affiliated with AWS; cite the AWS API Gateway pricing page | Contingency only |
| G10 | Gateway costs "cents to a few dollars" | Browser pings are billed; 25 s pings cost about $12 a month at 60 concurrent users | Item 12 |
| G15 | AppSync auth through a Lambda authorizer reading the cookie | Credentials travel in a base64url subprotocol; JavaScript cannot read an HttpOnly cookie; a ticket or OIDC would be needed | Confirms option B's rejection (RI-65) |
| G16 | AppSync limits "—" | 24 h connections, 60 s keep-alive, 2,000 connections/s, 240 KB events, 25 publishes/s per connection | Context only |
| H6 | Web Push as the wake path, with a `{conv, seq}` payload | No silent push | Item 11 |
| H10 | Safari has had WebSocket since 4.2 | 4.2-5.1 partial; full RFC 6455 from iOS 6 | No effect (all targets are newer) |
| I1 | Gmail Chat launched on the announcement day | Rollout began one day before the announcement (2006) | History only |
| I5 | The invisible-mode failure message | The verified wording blames other desktop software that lacks invisibility | History only (invisible is never offered) |
| I7 | Presence colours from a 2008 forum quote | Primary source: the 2006 help page lists Green, **Yellow (idle)**, Red, Grey; the 15-minute rule dates from launch | FV-70, FV-71 |
| I11 | "Sent at 3:42 PM on Tuesday" [inferred] | "Sent at 2:07 am on Wednesday" (lowercase am/pm) | FV-37 |
| I13 | Mole width about 225-260 px | 229 px (2006, grey #999999 border); 225 px (2007, #BBBBBB border) | FV-16 |
| I14 | Mole height about 300-350 px | Grows with content: about 155 px minimum, observed up to about 267 px, maximum unknown; title bar 23-24 px, #73A6FF | FV-17, FV-20 |
| H7 (unverifiable) | iOS PWAs lose sockets when backgrounded | No Apple statement; strong indirect evidence | Keep [inferred]; RI-75 |
| I18 (unverifiable) | "{name} has entered text" | Community-reported only | Keep [I]; FV-74 |

---

## 6. Fidelity value sheet (AC3)

### 6.1 Tag rules

- **[S]** (sourced): the value is **verified** in DOC-363B23B01410 section 3 I (claim id given).
- **[I]** (inferred): not verified there. This includes values chat.md tagged [S] from sources the verification did not check, and design choices no source fixes. Every [I] value is shown to io as inferred at `hfy-chat-uat` and can be cut there.
- **[DS]**: fixed by the io-approved design system (HFY-R13, HFY-R30, HFY-R72, D-11, WCAG) or by io's own rules (R-xx). [DS] wins any conflict with [S]. Where they conflict, the sheet keeps the Gmail value in the note, so the theme can match its hue or proportion, and records how the conflict is resolved (FV-16, FV-20).
- **Q10 defaults are not io-approved.** Q10 (Q2-16) is open (section 7.1). AC3 allows only the three tags above, so the three default-off values (FV-23's post-creation private/open change, FV-30 and FV-56) keep the [DS] tag with the annotation "BRD2 Q2-16 default, pending io's Q10 answer; confirmed or cut at `hfy-chat-uat` (AC4)". That annotation marks them as the planned default, not an io decision.
- **CHAT-D10 readings are not io-approved either.** Renaming a group after creation and direct chats that cannot be left are interpretations of R-38, annotated "CHAT-D10 interpretation, pending io's confirmation at `hfy-chat-uat` (AC5)" (FV-23; section 7.3).
- Every value is a `--io-chat-*` token in rem in `packages/chat/src/tokens.css`, which harrisonfamily aliases in its theme layer. Pixel figures assume a 16 px root.
- "Kit value" is what `chat-kit-react-conversation` and `chat-kit-react-shell` build. Where it differs from chat.md, the change is listed in follow-up F-07.

### 6.2 The sheet: every chat.md section 15 value, plus the section 10-12 values it renders

| id | chat.md value | kit value | tag | evidence / note |
|---|---|---|---|---|
| **§15 general** | | | | |
| FV-01 | Values are `--io-chat-*` tokens in rem, aliased by the HFY theme | same | [DS] | theme-lint forbids literals in islands CSS |
| **§15.1 Desktop, 64rem (1024 px) and wider** | | | | |
| FV-02 | Breakpoint 64rem (1024 px) | same | [DS] | — |
| FV-03 | Roster panel at the bottom left | same | [I] | chat.md tagged [S] from 2006 screenshots. Section 3 I verifies only the bottom-right dock (I19). The design system has no sidebar (HFY-R72). |
| FV-04 | Panel title bar 2.75rem (44 px): your dot, "chat", minimize | same | [DS] | Gmail's title bars were 23-24 px (I14); the 44 px target wins |
| FV-05 | Panel 15rem wide when expanded | same | [I] | No source |
| FV-06 | Panel `min(28rem, 70vh)` tall | same | [I] | No source |
| FV-07 | Search field "search family", 16 px text, above the lists | same | [DS] text size; [I] placement | The research cites the patent's contact-list search; not in section 3 I |
| FV-08 | `q` focuses the search when focus is not in an input | same | [I] | **Retagged** from chat.md's "[S: Gmail shortcut `q`]". Not checked by the verification (BRD2 Appendix C). Default on (Q2-16, pending io's Q10 answer). |
| FV-09 | "groups": by last activity, bold when unread, "new group" at the top | same | [I] | A design choice; Gmail had no group list |
| FV-10 | "family": online first (active, idle, alphabetical), then your recent chats (30 days) by recency | same | [I] | The research's ordering was [inferred]. Recent-not-frequent is D10. |
| FV-11 | Up to 40 rows | same | [I] | **Retagged** from chat.md's [S] ("Gmail's 40-contact cap"): the research found no figure, and section 3 I is silent |
| FV-12 | Search reaches every eligible member | same | [DS] | R-36 |
| FV-13 | "recent" uses only your own conversations | same | [I] | A privacy design choice (D10) |
| FV-14 | Panel open or closed is remembered (`hfy:chat:panel`) | same | [I] | — |
| FV-15 | Moles docked at the bottom right, laid out right to left | same | **[S]** | I19 (the 2006 chat landing page) |
| FV-16 | Mole width 16rem (256 px) [I: 225-260 px] | **14.3125rem (229 px)** | **[S]** | I13: 229 px (2006), 225 px (2007); item 13. The 2006 value is the original. 225 px (14.0625rem) is the verified alternative. **Conflict with [DS] 44 px targets:** Gmail's width was measured on 23-24 px chrome (I14). A 44 px title bar holding a dot, the name and four 44 px controls (options, minimize, pop-out, close) would spend about 176 of the 229 px and leave about 40 px for the name. Resolution in FV-20: the width stays [S], and the title bar drops to three controls. A wider mole is not taken, because the 225-229 px width is one of AC3's [S] values. |
| FV-17 | Mole body 20rem tall [I: 300-350 px] | **Height grows with content**: minimum about 9.6875rem (155 px) for the whole mole; capped at 20rem, after which the transcript scrolls | **[S]** growth and minimum; **[I]** maximum | I14: observed up to about 267 px; the maximum is unknown, so the 20rem cap is inferred |
| FV-18 | Gap between moles 0.5rem | same | [I] | — |
| FV-19 | Right margin `--io-space-6` | same | [DS] | — |
| FV-20 | Mole title bar 2.75rem | 2.75rem, holding the dot, the name and **three** 44 × 44 px controls: options, pop-out ↗, close × | [DS] height and targets; [I] the control set | Gmail: 23-24 px, light blue #73A6FF (I14). The height is the DS target, and the colour is a DS token that may take the Gmail hue. **Conflict with FV-16, and its resolution:** desktop title-bar controls keep 44 px targets (D-11, HFY-R30's 44 px control), and the separate minimize glyph goes, because clicking the title bar already minimizes (FV-24). Three controls take 132 px and leave about 95 px for padding, the 9 px dot and the name, so about 70 px of name, truncated with "…", with the full name in the accessible name and `title`. If the D-11 audit at `hfy-chat-uat` finds the name too short, pop-out moves into the options menu next (about 115 px of name), before any widening. io sees the control set at UAT (FV-24 and FV-25 are [I]). |
| FV-21 | Title: presence dot, then the name or group title | same | [S] the participant list in a group's title (I3); [I] the direct-chat title content (the peer's name) and the dot's position | I3 is a claim about group rooms only; the direct-chat title is not verified |
| FV-22 | Unnamed group: "{a}, {b} and {n} more" | **"({n}) {a},{b},{c}"** (the verified comma form, no space after the commas), truncated to fit with "…" | **[S]** the count prefix and the comma-joined participant list (I3); **[I]** the "…" truncation | I3 verifies the title format "(3) name,name,name". A named group shows its name (R-38, [DS]). **Reconciled with chat.md §10.3**, which puts "{n} people · {k} online" and a strip of member dots in a group's title bar: the 229 px title bar holds only the title (this form or the name), so the "{n} people · {k} online" summary and the member-dot strip sit in one row directly under the title bar, at the top of the mole body. [DS] presence in every chat (R-37); [I] the placement. F-07 carries the matching §10.3 edit. |
| FV-23 | Options button (person-plus): add people; rename and private/open (creator only); leave chat | same, except **changing private/open after creation is off by default** | [I] button; [DS] add people, private/open at creation and leave chat (R-38); [DS] rename after creation, annotated "CHAT-D10 interpretation, pending io's confirmation at `hfy-chat-uat` (AC5)"; [DS] the post-creation private/open change off, annotated "BRD2 Q2-16 default, pending io's Q10 answer; confirmed or cut at `hfy-chat-uat` (AC4)" | chat.md cited 2012 help, which is not in section 3 I. The verified Options menu (I2) held "group chat". **Direct chats show no "leave chat"**: also a CHAT-D10 interpretation, pending io's confirmation at `hfy-chat-uat` (AC5), because io's words are "members can choose to leave a chat at any time" (section 7.3). |
| FV-24 | Minimize; clicking the title bar also toggles it | Clicking the title bar (the name area, a `button` with `aria-expanded`) minimizes and restores; **no separate minimize glyph** (FV-20) | [I] | chat.md cited 2012 help; not verified. The glyph is dropped to fit 44 px targets into the [S] width (FV-16, FV-20). |
| FV-25 | Pop-out ↗ | same | **[I]** | **Retagged** from chat.md's "pop-out ↗ [S]". Not checked (BRD2 Appendix C). Default on (Q10: "docked pop-out windows", pending io's answer). Stays a title-bar control unless the FV-20 fallback moves it into the options menu. |
| FV-26 | Close × | same | [I] | — |
| FV-27 | Body order: transcript, typing line, composer | same | [I] | — |
| FV-28 | As many moles as fit (at least 1); the rest collapse into a "{n} more" chip; opening a hidden one swaps out the least recently focused | same | [I] | — |
| FV-29 | Pop-out opens `/chat/?c=<id>&popout=1` in a 420 × 560 window | same | [I] | — |
| FV-30 | An incoming message with no open mole opens one, unfocused, with a flashing title | **No auto-open by default.** The roster row goes bold and the entry shows a dot. The highlight applies to moles already open. | [DS], annotated: BRD2 Q2-16 default, pending io's Q10 answer; confirmed or cut at `hfy-chat-uat` (AC4) | The sheet's Q10 default ("windows opening by themselves": off); BRD2 11.5. Not an io decision until io answers Q10. |
| FV-31 | The title bar highlights on a new message | An orange highlight on the mole's title bar | **[S]** | I15: the orange #FF8A00 title bar is confirmed. The colour is a DS token with that hue. |
| FV-32 | The title bar flashes | same | **[I]** | I15: flashing is unverifiable. Default on (Q10: "flashing title"). |
| FV-33 | In a hidden tab, `document.title` alternates "{name} says…" every 1.5 s until focus | same | **[I]** | I15: tab-title alternation is unverifiable; the string and the period are inferred |
| FV-34 | Under `prefers-reduced-motion`, both become a static highlight | same | [DS] | — |
| FV-35 | Runs: the first line is `me: {text}` or `{name}: {text}`; later lines are indented with no name | The sender name once in bold, later lines indented | [S] grouping and indentation (I12); [I] the `me:` label | **Retagged:** chat.md's blanket "Transcript [S: patent US7814159, plus screenshots]" covered the `me:` label; section 3 I does not verify it |
| FV-36 | A "sent at" line under a message when the next one, or now, is more than 5 min later | same | **[S]** | I9 and I10: the patent's break line, with a 5-minute example threshold |
| FV-37 | The text `sent at 3:42 pm on tuesday` | `sent at {h:mm} {am\|pm} on {weekday}`, for example `sent at 2:07 am on wednesday` | **[S]** form (I11); [DS] lowercase | I11: "Sent at 2:07 am on Wednesday". Only "Sent" and the weekday lose their capitals (D3). |
| FV-38 | A centred grey line | same | [I] | **Retagged** from chat.md's blanket transcript [S]. The patent describes a break line; the style is not measured. |
| FV-39 | Older than 6 days: `on <month> <day>` | same | [I] | **Retagged** from chat.md's blanket transcript [S]; no source in section 3 I |
| FV-40 | Each message's exact time in its `title` and accessible name | same | [DS] | Accessibility |
| FV-41 | System rows in grey italic: started, named, added, left, made open, made private | same | [S] system lines exist (I3); [I] the grey italic style; [DS] wording | I3 confirms only that system lines exist, not their style. **Retagged** (style) from chat.md's blanket transcript [S]. |
| FV-42 | A late joiner's first line: "you joined. you'll see messages from here on." | same | [DS] | R-38 |
| FV-43 | Your pending message is grey and darkens on `ack` | same | [I] | **Retagged** from chat.md's blanket transcript [S]. Research detail 1, not a Gmail claim. |
| FV-44 | A failure shows "not sent. tap to retry."; `PACE_WAIT`, `CONTACT_INFO` and `MEDIA_URL` put the text back in the composer | same | [DS] | R-39, R-18, R-34; D12 |
| FV-45 | New messages in a focused mole are announced once by a polite live region | same | [DS] | — |
| **§15.2 `/chat/` page, desktop** | | | | |
| FV-46 | Two panes: the roster in a left column and the conversation in the main column; other moles stay docked; `?c=` selects; the push landing page | same | [I] | The multi-page answer; not a Gmail claim |
| **§15.3 Medium, 43rem to 64rem (688-1024 px)** | | | | |
| FV-47 | The same dock; the panel collapsed by default; usually one mole fits | same | [DS] breakpoints; [I] behaviour | — |
| **§15.4 Phone, under 43rem (375 px reference)** | | | | |
| FV-48 | Breakpoint under 43rem; 375 px reference | same | [DS] | — |
| FV-49 | Entry: a chat icon (speech bubble, `currentColor` mask) with an unread dot in `.hfy-bar__end` before the account button, linking to `/chat/`; the bottom bar keeps its 5 items | same | [DS] | Joint 375 px check with the notifications and nav domains (chat.md §26) |
| FV-50 | `/chat/` roster full screen: search, groups, family, 44 px rows | same | [DS] | — |
| FV-51 | Conversation full screen with `history.pushState`, so Back returns to the roster | same | [I] | Research detail 3, not a Gmail claim |
| FV-52 | Header: back, dot, name, ⋯ options | same | [DS] | — |
| FV-53 | The composer pinned above the safe area **with a visible "send" button** | The composer pinned above the safe area, with **no Send button**: Enter sends, and `enterkeyhint="send"` labels the keyboard key | **[S]** no Send button (I6; item 13); [DS] safe area | BRD2 11.5; `chat-kit-react-conversation` AC. Default on (Q10: "Enter sends"). |
| FV-54 | `html.hfy-chat-convo` hides the compact bottom bar while a conversation is open | same | [DS] | — |
| FV-55 | D-11 at 375 px: 16 px inputs, 44 px targets, one control height per row, no horizontal scroll, axe clean, an installed-PWA pass | same | [DS] | — |
| FV-56 | No auto-opening: an incoming message updates the entry dot and the roster only | same | [DS], annotated: BRD2 Q2-16 default, pending io's Q10 answer; confirmed or cut at `hfy-chat-uat` (AC4) | The sheet's Q10 default; not an io decision until io answers Q10 |
| FV-57 | Group chat in the phone view (Gmail's mobile web app had none) | same | [I] | chat.md tagged [S], "deliberately different"; not in section 3 I. R-36 requires groups. |
| **§15.5 Copy (design-system voice: lowercase sentences; names as labels)** | | | | |
| FV-58 | Desktop placeholder: "type a message. press enter to send." | same | [S] hint (I6: Gmail's fix was the hint "Press enter to send your message"); [DS] wording | — |
| FV-59 | Mobile placeholder: "type a message" | same | [DS] | The keyboard key carries "send" (FV-53) |
| FV-60 | Peer offline: "{name} is offline. they'll see your message when they're back." | same | [DS] wording; [I] the Gmail precedent | The research quotes a Gmail offline line; section 3 I does not verify it |
| FV-61 | Pacing: "{name} is offline. you can send another message after they reply." | same | [DS] | R-39 |
| FV-62 | Contact info: "chat can't carry phone numbers or addresses. remove the highlighted part to send." | same | [DS] | R-18; shared with the privacy domain |
| FV-63 | Media URL: "chat is text and emoji only. links to photos, gifs or videos can't be sent." | same | [DS] | R-34 |
| FV-64 | Paste or drop of a file: "chat is text and emoji only." | same | [DS] | — |
| FV-65 | Too long: "that's too long for chat. keep it under 1,000 characters." | same | [DS] | CHAT-D20 |
| FV-66 | Queued: "sends when you're back online." | same | [DS] | — |
| FV-67 | "reconnecting…", shown after 2 s | same | [DS] copy; [I] the 2 s | Research detail 7 |
| FV-68 | Unavailable, signed out, new version, leave confirm, flag off: the §15.5 strings | same | [DS] | — |
| **Values §15 renders from §10-§12** | | | | |
| FV-69 | Presence dot (no size in chat.md) | **9 × 9 px (0.5625rem)** | **[S]** | I16 |
| FV-70 | Dots: green (online), orange with white clock hands (idle), grey hollow ring (offline) | Green (online); **yellow** with a clock glyph (idle); grey hollow ring (offline) | [S] hues (I7: Green, Yellow for idle, Red, Grey); [I] the clock glyph; [DS] exact tokens at 3:1 non-text contrast, shape plus text (WCAG 1.4.1, 1.4.11) | The research said yellow/orange (Part 1B); its top-10 list and chat.md said orange; the primary 2006 page says yellow. A pale yellow fails 3:1 on light surfaces, so the DS token is a darker yellow or amber. Busy (red) stays off. |
| FV-71 | Idle after 15 min without input; it cannot be chosen manually | same | **[S]** | I7 |
| FV-72 | "{name} is typing…" | same | **[S]** | I17 |
| FV-73 | "{a} and {b} are typing…"; "several people are typing…" | same | [I] | Group variants are ours (R-40) |
| FV-74 | "{name} has entered text." (and the 2-person and 3+ forms) | same | **[I]** | I18 is unverifiable. Default on (Q10 "is typing" / Q2-16). |
| FV-75 | Typing timings: refresh at most every 3 s; `paused` after 5 s; receiver expiry 7 s; a 60 s safety expiry for `paused` | same | **[I]** | I17: the timings are undocumented |
| FV-76 | Typed emoticons render as emoji; the stored text is unchanged; the original token is in the accessible name | same | **[S]** conversion (AC3 requires it): the post verified under I2 is the source the research quotes for typed-shortcut conversion (DOC-926937A24A07 Part 1A); the I2 row itself records the post, group chat from the Options menu, and that archiving and off the record still work. [I] the 14-token list | Default on (Q10: "typed smileys become emoji") |
| FV-77 | A blue smiley button at the right edge opens a grid of 32 Unicode emoji | same | [I] | The research places the picker at the bottom right; section 3 I does not verify the position, colour or grid size |
| FV-78 | Enter sends; Shift+Enter adds a new line on desktop; the input grows to 4 lines | same | **[S]** Enter sends, no Send button (I6); [I] Shift+Enter and 4 lines | — |

### 6.3 Tag check against the AC's list

| AC item | row | tag |
|---|---|---|
| Docked moles (I19) | FV-15 | [S] |
| Orange title bar on a new message (I15) | FV-31 | [S] |
| Typed emoticons converting (I2) | FV-76 | [S] |
| "is typing…" (I17) | FV-72 | [S] |
| Sparse "sent at" line, 5-minute gap, "Sent at 2:07 am on Wednesday" form (I9-I11) | FV-36, FV-37 | [S] |
| No Send button (I6) | FV-53, FV-58, FV-78 | [S] |
| Idle at 15 minutes (I7) | FV-71 | [S] |
| Mole width 225-229 px (I13) | FV-16 | [S] |
| 9 × 9 px presence ball (I16) | FV-69 | [S] |
| Title-bar flashing and tab-title alternation | FV-32, FV-33 | [I] |
| "has entered text" (I18) | FV-74 | [I] |
| 3/5/7 s typing timings | FV-75 | [I] |
| The mole's maximum height | FV-17 | [I] |
| Pop-out | FV-25 | [I] |
| The `q` shortcut | FV-08 | [I] |

Tags chat.md had wrong and this sheet changes:
- **From [S] to [I]:** FV-03, FV-08 (`q`, chat.md "[S: Gmail shortcut q]"), FV-11, FV-23 (the button), FV-24, FV-25 (pop-out, chat.md "pop-out ↗ [S]") and FV-57; and, under chat.md's blanket "Transcript [S: patent US7814159, plus screenshots]", FV-35 (the `me:` label), FV-38 (the centred grey line), FV-39 (older than 6 days), FV-41 (the grey italic style) and FV-43 (pending grey). AC3 requires `q` and pop-out to be [I], so chat.md must not keep them as [S].
- **From [S] to [DS]:** FV-23's menu items (chat.md cited 2012 help), and, under the same blanket transcript tag, FV-40, FV-42, FV-44 and FV-45.

Values superseded by verified facts, by the Q10 defaults (pending io's answer) or by the FV-20 conflict resolution: FV-16, FV-17, FV-20, FV-22, FV-24, FV-30, FV-37, FV-53 and FV-70.

---

## 7. io's open choices: Q10 (Gmail habits), Q4 ("online") and the CHAT-D10 readings

### 7.1 Q10: "Should chat copy the original Gmail chat's habits?" (Q2-16). Status: OPEN

This is **io's choice**. This ADR does not record or presume an answer. The decision sheet (DOC-C31D9E3DD932) asks it verbatim:

> **Q10. Should chat copy the original Gmail chat's habits?** *Blocks W5 chat launch.*
> Why: you asked for an obsessive copy, no bells and whistles.
> Default: on: docked pop-out windows, flashing title, typed smileys become emoji, "is typing", Enter sends. Off: windows opening by themselves, changing a group's privacy later, phone alerts. Never: reactions, photos, read receipts.

On "defaults ok", the defaults below apply as the starting set (BRD2 2.2, Q2-16):

| sheet default | Q2-16 item(s) | kit option default | tags (section 6) |
|---|---|---|---|
| **On:** docked pop-out windows | Docked moles; pop-out | on | moles [S] (FV-15); pop-out [I] (FV-25) |
| **On:** flashing title | Title-bar highlight on a new message; title-bar flashing; tab-title alternation while hidden | on | highlight [S] (FV-31); flashing [I] (FV-32); tab title [I] (FV-33) |
| **On:** typed smileys become emoji | Typed-emoticon conversion | on | [S] (FV-76) |
| **On:** "is typing" | "is typing…"; the paused "has entered text" | on | [S] (FV-72); [I] (FV-74); timings [I] (FV-75) |
| **On:** Enter sends | Enter to send with no Send button on any device | on | [S] (FV-53, FV-78) |
| On (in Q2-16, not named on the sheet line) | Sparse "sent at" lines; `q` to focus search; idle after 15 min | on | [S] (FV-36, FV-37); [I] (FV-08); [S] (FV-71) |
| **Off:** windows opening by themselves | Auto-open on incoming messages | off | [DS], annotated as the BRD2 Q2-16 default pending this answer (FV-30, FV-56) |
| **Off:** changing a group's privacy later | A private/open change after creation (a `chat-kit-server-core` server option) | off | [DS], annotated as the BRD2 Q2-16 default pending this answer (FV-23) |
| **Off:** phone alerts | Chat web push, a per-user setting (CHAT-D12 as amended) | off | — |
| **Never:** reactions, photos, read receipts | Also GIFs, attachments, "last seen", invisible, off the record | never offered | section 4.10 |

How the answer is recorded:
1. `io-policy-decisions` records io's sheet answer ("defaults ok" or "Q10: …") verbatim, with its date. That is the starting set.
2. `hfy-chat-uat` records keep or cut for each Q2-16 item on production, and shows the [I] items to io as inferred.
3. Each item is a host or server option, so no kit or install task waits on Q10. It blocks only the W5 launch (`hfy-chat-flip`).

### 7.2 Q4: what "online" means (Q2-08, CHAT-D5). Status: OPEN

The default and the answer slot are in section 3. Gate `q2-08-chat-online` blocks `chat-kit-server-core` and `hfy-chat-uat`. io confirms the feel again at UAT.

### 7.3 CHAT-D10 readings of io's group rules. Status: OPEN (confirmed at UAT)

These are interpretations of io's words (R-38), not io decisions. BRD2 11.5 (review IF-12) lists them for io, and `hfy-chat-uat` AC5 records io's confirmation. They are not on the decision sheet. The kit builds them as the default, and io can change each at UAT.

| reading (CHAT-D10) | io's words it interprets | where it shows |
|---|---|---|
| Direct chats cannot be left | "members can choose to leave a chat at any time, but must be invited back" | D14; FV-23 (no "leave chat" in a direct chat) |
| Invites add people at once (no accept step) | "if open, anyone already in the chat can invite any other member" | RI-09; §8.2 |
| The creator may rename the group after creation | "group chats can be named by the first person to create it" | D13; FV-23 |
| A private group whose creator has left becomes invite-locked | "if private, only the chat creator can invite people" | §8.2 |

The direct-chat reading is the one most at odds with io's literal words, so it stays visible to io until AC5 records an answer.

---

## 8. L-09 amendment text (AC4)

**Where it lands.** `chat-kit-protocol` adds the note to io-kit `docs/explanation/realtime-and-feeds.md`, under "Decision history". It replaces the sentence "No amendments recorded yet." The same PR adds `docs/explanation/chat-architecture.md`, and a matching line goes into the BRD inference register (DOC-4B28ED908326), as the doc's own rule requires. That rule says "A decision is never rewritten silently", so the L-09 paragraph and "Why AppSync Events" stay word for word.

**Note text** (paste as is; fill in the date the PR merges and this ADR's docstore id):

```markdown
### <YYYY-MM-DD>: L-09 and the AppSync Events transport, a scoped exception for `@io-kit/chat` (CHAT-D4)

**Decision.** L-09 and the AppSync Events choice stand for every package except `@io-kit/chat`. The chat socket carries message bodies, typing state and presence state, and its server is a stateful chat hub, not AppSync Events. In the reference adapter (`@io-kit/chat/cloudflare`) the hub is a Cloudflare Durable Object with WebSocket Hibernation, behind a Worker route on the stack's own host. Feeds keep signals only over AppSync Events.

**Why L-09's reasons still hold for chat.**
- One enforcement point. The chat hub is the only store and the only reader of chat data. Membership epochs, the 30-day visibility window, direct-chat pacing and the text policy are all checked in the hub before any frame leaves it, and no HTTP route serves chat messages. Chat data has no second authorization path.
- Correctness does not depend on delivery. Every message has a gap-free per-conversation `seq`. The `ack` is sent only after the write commits. Clients deduplicate by `(conv, seq)` and fill gaps with `page {after}`. A dropped or duplicated frame costs a refetch, never a leak or a gap.
- The socket's session check is a second verifier, not a second policy. The chat Worker verifies the stack's existing session cookie against the same JWKS, issuer, audience and clock skew as the stack's gate, and its tests port the gate's cases. No token is minted for page JavaScript.

**Why signals-then-fetch does not fit chat.** It adds a fetch round trip to every message. AppSync Events has no connect or disconnect hook, so presence could only be heartbeat-based. Race-free pacing needs one serialized writer. Chat's requirements (low latency, presence bound to connections, race-free pacing) need a stateful server.

**Limits.**
- The exception covers `@io-kit/chat` only. Any other package that wants payloads on a socket needs its own dated note.
- Realtime stays off by default. A stack gets chat only by installing `@io-kit/chat` and running its own hub; infrastructure stays per stack.
- The protocol is transport-neutral (`ChatTransport`, `ChatStore`). A stack that cannot run Cloudflare can run the same core behind API Gateway WebSocket, and keeps every condition above.
- Chat push notifications never carry message text.

**Source.** io's decision of 2026-10-13, "chat on cloudflare" (HFY-R77, HFY-PLN-002); the HFY-PLN-002 chat ADR (<DOC id>); verification DOC-363B23B01410.
```

**BRD inference-register line** (DOC-4B28ED908326, in the register's own column format):

> L-09 / AppSync Events (realtime-and-feeds.md), amended <YYYY-MM-DD>: `@io-kit/chat` alone carries message bodies, typing and presence on its own socket to a stateful hub (Cloudflare Durable Object adapter); feeds keep signals only over AppSync Events. Basis: io's decision of 2026-10-13, "chat on cloudflare" (HFY-R77); CHAT-D4; the HFY-PLN-002 chat ADR. Inference: L-09's single-enforcement-point reason holds because the hub is the only store and reader of chat data, and no HTTP route serves it.

**Front matter.** The doc's front matter says `package: feed`, but L-09 is worded kit-wide, so the note sits in this doc and `chat-architecture.md` links back to it. The note does not change the front matter.

---

## 9. Cost note (AC5)

**Total: about $5-7 a month on Workers Paid at family scale** (DOC-363B23B01410 section 2 item 7, section 4.4).

- **The $5 is already paid.** It is the Workers Paid monthly minimum that io's account already pays (verified 2026-10-13), shared with the account's 4 other Workers. Chat adds no subscription. The $0-2 above it is usage beyond the included quotas, which all the account's Workers share.
- **Pricing on Workers Paid** (F1, F2, section 4.4):

  | item | price |
  |---|---|
  | Base | $5 a month minimum (already paid) |
  | Durable Object requests | 1M included, then $0.15 per million |
  | Duration | 400k GB-s included, then $12.50 per million GB-s. Each object is billed as 128 MB while awake (F10). |
  | Storage | 5 GB-month included, then $0.20 per GB-month |

- **Only incoming WebSocket messages get the 20:1 discount.** Everything else is a **full-price request**: each reconnect (a socket upgrade forwarded to the object), every Worker-to-object and object-to-object RPC, fan-out done through RPCs, presence updates sent as requests, and every alarm. Outgoing WebSocket messages are free (F2). The docs do not say whether auto-responded pings count (F9); that stays open, and F-12 proposes the check.
- **Overage is billed in whole units.** Going 1 GB-s over the included duration costs a full $12.50 unit. So **nothing may block hibernation** (F3): a month whose awake time crosses the included 400k GB-s turns $5 into $17.50 or more. The hub must avoid all of these:
  - `setTimeout` or `setInterval`;
  - sockets accepted with `ws.accept()` instead of `ctx.acceptWebSocket`;
  - outbound connections held open, or pending I/O left running.

  Grace, sweep and outbox work run as storage alarms. Ping is answered by `setWebSocketAutoResponse`, and typing expiry runs in the receiver (item 8).
- **Workers Free is not an option.** It allows 100k object requests a day, returns errors past that, and resets at 00:00 UTC (F6). The verification says chat "would likely fail mid-day once everyone uses it" (item 7), and its decision is "Workers Paid is required, not optional". The requirement rests on io's ruling (chat on Cloudflare, on an account that already pays for Workers Paid), that decision, and the hard errors past any daily cap, not on steady fan-out: this ADR's one-hub estimate below is about 17k requests a day (chat.md §23 says about 7k), under the cap. A runaway client loop (chat.md §23) or clients stuck in a reconnect loop after a deploy could still hit the cap, and on Free that would be an outage for everyone until 00:00 UTC.
- **Correction to chat.md section 23.** "About $0 extra" and a "$0.05 a month delta" are replaced by "about $5-7 a month in total, of which $5 is the existing subscription" (BRD2 11.5). The AWS side (the hfy-api service calls, the DynamoDB archive at about 25k WRU a month, push) adds cents. `hfy-chat-worker-prod` writes the line into `docs/reference/cost-estimate.md`.

**Supporting arithmetic for the one-hub design.** This is this ADR's own estimate, from F1, F2 and F10. No task measures it today. This ADR proposes the checks (F-12, F-16): `chat-cf-spike` reads whether auto-responded pings are billed, `hfy-chat-load-latency` reads the staging hub's usage over the L5 soak, and a post-flip operations task reads production usage.
- **Duration is bounded.** One hub awake for a whole month is 2,592,000 s × 0.125 GB = **324,000 GB-s**, under the 400k included, even if it never hibernated. The staging hub is a second object on the same account: a 72 h soak with it awake adds about 32,400 GB-s. Two objects awake all month would cross 400k and cost a $12.50 unit, which is why the rule above matters. The 30 s liveness sweep wakes the hub while anyone is connected. At about 10 s awake per wake (F20) that is up to about a third of connected time, well inside the bound. Lengthening the sweep is the first lever if duration grows.
- **Requests stay inside the included million.** With 300 members, page-view connects dominate (one per navigation on the multi-page site, §6.6). At 20 page views a member a day that is about 180k a month. Add about 43k hourly session renewals at 60 online, at most about 86k sweep alarms, and incoming frames ÷ 20 at about 150k. That totals about 0.5M a month, or about 17k a day. The verification says "several million requests" (F5) and names RPC fan-out among the causes. **This ADR's inference**, not the verification's statement, is that the figure describes the research's three-object topology with RPC fan-out, which one hub does not have. The measured usage (F-12, F-16) settles it. The $5-7 envelope holds either way.
- **Shared quotas.** Every Worker and object on the account, including staging, draws on the same included quotas. A runaway Worker elsewhere is billed, not blocked (chat.md §26). The post-flip usage reading belongs to a proposed operations task (F-16), not to `hfy-chat-worker-prod`, which is W3 and closes before the W5 `hfy-chat-flip`.

---

## 10. Consequences and follow-ups

This ADR edits no design file. Each follow-up names the task, or the orchestrator's design pass, that applies it. BRD2 section 11 is binding where it already covers an item.

| id | follow-up | owner |
|---|---|---|
| F-01 | Replace chat.md §23 with the cost note (section 9) | `hfy-chat-worker-prod` (docs AC); orchestrator design pass |
| F-02 | In chat.md §3.1, the "app ping every 25 s" becomes the auto-response ping, and the grace and sweep become alarms (item 8) | `chat-kit-cloudflare` |
| F-03 | Add rows D6-D16 to chat.md §3.2, and update the D1 and D3 reasons as in section 4.9. AC1 is met only once this lands. | Orchestrator design pass, **before io approves this ADR** |
| F-04 | Add "Always show / Never show per contact" to chat.md §3.3 as optional (off). AC1 is met only once this lands. | Orchestrator design pass, **before io approves this ADR** |
| F-05 | Remove chat.md §12.1's coarse-pointer send button and §15.4's visible "send" button (no Send button; `enterkeyhint="send"`) | `chat-kit-react-conversation` (already in its AC) |
| F-06 | chat.md §13: `chat_message` push becomes a per-user setting that defaults off (CHAT-D12 as amended; Q10 "phone alerts") | `hfy-chat-api-service-routes`, `hfy-chat-island` |
| F-07 | Apply the section 6 kit values: mole width 14.3125rem (FV-16); height grows, capped at 20rem (FV-17); the title bar with three 44 px controls and minimize as the title-bar toggle (FV-20, FV-24); the unnamed group title in the verified comma form (FV-22), with the matching chat.md §10.3 edit (the "{n} people · {k} online" summary and member dots in a row under the title bar); no auto-open (FV-30); the I11 "sent at" form (FV-37); the 9 px dot (FV-69); the yellow idle hue (FV-70). Apply the retags in chat.md §15: [S] to [I] for FV-03, 08 (`q`), 11, 23 (button), 24, 25 (pop-out), 35 (the `me:` label), 38, 39, 41 (grey italic style), 43 and 57; [S] to [DS] for FV-23's menu items and FV-40, 42, 44 and 45; and replace the blanket "Transcript [S: …]" tag with per-value tags | `chat-kit-react-conversation`, `chat-kit-react-shell`; a harrisonfamily theme-token patch if a token is missing |
| F-08 | The outbox lives in IndexedDB (`chat-kit-client` AC) while chat.md §6.6 keeps the snapshot in sessionStorage. Reconcile §6.6. Sign-out must also clear the IndexedDB outbox, so no queued text outlives a session on a shared computer. | `chat-kit-client`, `hfy-chat-shell-presence` (sign-out sweep) |
| F-09 | Confirm that the `io_id` cookie's Path covers `/chat`, and record zone settings that touch WebSockets | `chat-cf-spike` (AC1, AC4) |
| F-10 | Decide and record the Durable Object jurisdiction before the first production `get()` (F13), and pass a `locationHint` on that first `get()` (F12) | `hfy-chat-worker-prod` (AC3) |
| F-11 | Reconcile load size: chat.md §3.1 says 500 clients, §20.3 L1 says 300. Run L1 at 500, or record why not. | `hfy-chat-load-latency` |
| F-12 | Measure whether auto-responded pings count toward billed requests (F9), the per-hop latencies (F12) and the staging usage behind section 9's arithmetic. Neither task's ACs cover billing today, so this ADR proposes AC additions. **`chat-cf-spike`, new AC:** "One idle socket on the spike object sends only auto-responded pings (for example one every 25 s for 30 min) with no other traffic. The object's request count in Cloudflare's Durable Object metrics is read before and after that run, and the result, whether auto-responses are billed (DOC-363B23B01410 F9), is recorded." **`hfy-chat-load-latency`, new AC:** "The staging hub's Durable Object request and duration totals over the L5 soak are read from Cloudflare's metrics and compared with the chat ADR's section 9 arithmetic; a monthly projection past the included 1M requests or 400k GB-s becomes a filed fix task or a recorded io waiver." The per-hop latencies stay with `chat-cf-spike` AC3 (connect-to-first-frame and echo RTT) and the `hfy-chat-load-latency` report. | Orchestrator, to add the ACs; then `chat-cf-spike`, `hfy-chat-load-latency` |
| F-13 | Every deploy disconnects every socket (F7): deploy in io-chosen quiet windows; resume by `seq` covers the reconnects | `hfy-chat-worker-ci` (already in D2-26) |
| F-14 | The privacy amendment names Cloudflare as a processor of chat content, the 30-day view with indefinite retention, family-wide presence and account visibility | `io-policy-decisions` (Q8, already in its AC2) |
| F-15 | Align BRD2 11.5's wording ("storage alarms for the offline grace, typing expiry and dead-socket checks") with receiver-side typing expiry: the alarms cover the offline grace, dead-socket checks and outbox drains, and typing expires in the receiver (item 8) | Orchestrator design pass |
| F-16 | Post-flip usage reading. Proposed new operations task (working key `hfy-chat-usage-review`; W6, `no_code`, after `hfy-chat-flip`), with ACs: "The production hub's Durable Object requests, duration and storage for the first 30 days after the flip are read from Cloudflare's account metrics and recorded against the chat ADR's cost note; `docs/reference/cost-estimate.md` gets the measured line; a projection past the included quotas becomes a filed fix task or a recorded io waiver." | Orchestrator files the task; the task owns the reading |

**Positive consequences.** The transport question is closed for good. The cost is honest, the hibernation rules are pinned before code exists, and the Gmail values rest on verified evidence with the inferred ones visible to io.

**Negative consequences and risks.**
- A second platform and a CI credential (BRD2 R2-09).
- Phone-to-phone pacing will feel strict under the default "online" definition (R2-11; io's Q4).
- Several Gmail details stay inferred: the maximum height, flashing, the tab title, "has entered text" and the timings. These are shown to io at UAT.
- One hub is a single blast radius for a bad deploy. The conformance suite, the staging soak and the split path in §5.3 mitigate it.

---

## 11. Approval and open items

**What io's approval covers.**
- This intake: the register (section 4), the corrected values (section 5), the fidelity sheet (section 6), the L-09 note (section 8) and the cost note (section 9).
- It does **not** cover the transport. That is locked (section 3) and is not put to io again.
- It does not stand in for io's answers to Q4 and Q10. Those come from the decision sheet through `io-policy-decisions`.
- It does not confirm the CHAT-D10 readings (section 7.3). io confirms those at `hfy-chat-uat` (AC5).
- AC1 is complete only once F-03 and F-04 have landed in chat.md §3.2 and §3.3, before io's approval.

**Recorded on approval:** io's approval verbatim, with its date, on HFY-TSK-219.

**Still open** (DOC-363B23B01410 section 4.6, plus this ADR):
- the `io_id` cookie Path (F-09);
- whether auto-responses are billed (F-12);
- the hop latencies (F-12);
- the Durable Object jurisdiction (F-10);
- the staging and production usage behind the cost arithmetic (F-12, F-16);
- the unsourced Gmail details: the mole's maximum height, title-bar flashing and tab-title alternation, "has entered text", the 3/5/7 s timings, pop-out and `q`;
- the mole title-bar control layout (FV-20), checked at the D-11 audit in `hfy-chat-uat`;
- io's Q4 answer (section 3);
- io's Q10 answer (section 7.1);
- the four CHAT-D10 readings io confirms at `hfy-chat-uat` AC5 (section 7.3): direct chats cannot be left; invites add people at once; the creator may rename the group; a private group whose creator leaves becomes invite-locked.

---

## Review notes

Review round of 2026-10-13: twelve findings, all applied, none rejected.
- **Hedging finding (Workers Free):** applied as asked. The ADR now quotes item 7's "would likely fail mid-day". It also quotes section 4.4 of DOC-363B23B01410, which states without a hedge that fan-out "will exceed these limits". The finding did not mention that sentence, but it describes the research's three-object stack, so it does not change the fix.
- **FV-20 conflict:** the finding asked for a decision. This ADR keeps the [S] width and the [DS] 44 px targets, and drops the separate minimize glyph. Pop-out moving into the options menu is the fallback (FV-20). io sees the result at UAT, because FV-24 and FV-25 are [I].
- **FV-22:** the kit value now uses the verified comma form, with no space after the commas, so the [S] tag holds. Only the "…" truncation is [I].
