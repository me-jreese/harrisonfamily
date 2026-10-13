# HFY-PLN-002 design: user-facing surfaces (domain `surfaces`)

Requirements covered: **R-14** (on this day), **R-15** (signed-in /about/ call to action), **R-16** and **R-17** (profile links), **R-20** and **R-21** (nav: "me" and the gear), **R-23** and **R-42** (access-request sign-up from Legacy Form sections 1 and 2), **R-29** and **R-30** (photo tag display).
Requirements consumed, not owned here: R-18 (contact-info guard, privacy domain), R-19 (no DOB in the cloud, record/sync domain), R-06/R-08/R-09 (proposals and editing), R-13 (in-app inbox, notifications domain), R-22 (visualization, `viz.md`), R-31 (tag data architecture), D-01/D-02 (export fixes).

Sources: the requirement list (`pln2/requirements.md`), io's verbatim intent (DOC-2CFAE07B546C, `pln002-intent.md`), the discovery digest (`pln2/digest.md`), the PLN-001 BRD (DOC-7CBCCC1521DD) and rulings HFY-R1..R74, the design-system voice guide (`guide/04-voice.md` of the HFY-R13 artifact), the harrisonfamily read worktree at `c712e68` and io-kit at `31f6fb3`. Code citations are `path:line` in those trees. Counts come from a read-only copy of the Gramps DB; no person's name, date or contact detail appears here. In copy decks, `{steward}` stands for the family member the site tells people to text (the existing `VOICE.error` pattern).

---

## 0. Summary

| Area | What ships | Flag (default off) | Main dependencies |
|---|---|---|---|
| Nav (R-20, R-21) | "me" opens your own page; "family" leaves the bar until `/tree/` ships; a gear in the top bar opens a new `/me/` settings hub | `navMe` | `GET /api/me` (admin badge only) |
| On this day (R-14) | A homepage module with a tiered fallback (day, week, year milestones, past posts, a growth prompt), built from a gated month-day index in DynamoDB | `onThisDay` | D-02 event types; the record store's structured dates (R-19 projection) |
| About CTA (R-15) | A signed-in close to the /about/ story, four action cards with live counts and deep links | `aboutCta` | search deep-link params (this domain) |
| Profile links (R-16, R-17) | Seven member-owned links in DynamoDB, shared validator, chips in the person hero, an editor at `/me/links/` | `profileLinks` | `shared/` packaging (this domain) |
| Access requests (R-23, R-42) | `/join/` (email code, then Legacy Form S1 and S2), anonymous edge routes with Turnstile, honeypot and rate limits, an admin queue at `/me/requests/`, approval writes a DynamoDB allowlist entry | `accessRequests` + edge env `ACCESS_REQUESTS` | SES identity and production access (io gate), allowlist in DynamoDB, admins named |
| Photo tags (R-29, R-30) | Region overlays on gallery photos and in the lightbox, a names list under each tagged photo, hover cards with the tag data, touch and keyboard equivalents | `photoTags` | tag export per media item (R-31 / D-02 domain) |

No io-kit change blocks this domain (section 11).

---

## 1. Problem

### 1.1 Nav
- The bar has five items: home, family, search, posts, me (`islands/src/islands/shell.jsx:19-25`).
- Since PR #16 (`c712e68`), "family" opens the member's own page: `Shell()` swaps its route for `ownRoute(sub)` (`shell.jsx:174-178`, `islands/src/lib/family-route.js:5`). HFY-R74 records that.
- "me" opens `/me/notifications/` with `notifyV2`, else `/family-login/` (`shell.jsx:172-178`). It is really a settings destination.
- io's R-20 and R-21: the own page is "me"; a gear opens what "me" opens today.
- Constraints:
  - The kit caps the compact bottom bar at 5 primary items (`iokit packages/shell/src/registry.ts:24`, `PRIMARY_CAPS.compact = 5`).
  - `/family/` is a gated data prefix and must never be a nav route (`scripts/cloudfront/append-index.js:20`; asserted at `islands/tests/family-route.test.mjs:51-56`).
  - The tests pin today's shape:
    - the five ids and labels and `family=/private/` (`family-route.test.mjs:51-65`);
    - "five-item bottom bar (75 x 56 cells)" (`islands/tests/shell.spec.mjs:8,49-59,106`);
    - the account sheet's "your page" link (`shell.spec.mjs:202-210`, `family-route.spec.mjs:41-43`).
- The viz domain (`design/viz.md` §10) plans `familyViz`, which sends "family" to `/tree/`.

### 1.2 On this day
- The data cannot carry a day-level feature:
  - 4 of 169 events have a day and a month: 2 births and 2 deaths.
  - One of those births belongs to a person both living rules call living.
  - R-19 keeps every birth day and month out of the cloud.
  - That leaves 2 day-level items in the whole year, both deaths.
- No other dates exist:
  - 0 of 32 media rows have a Gramps date.
  - EXIF dates (2010–2015) are scan dates, not event dates.
  - There are 0 posts and 1 test comment.
- Year-only material is real but thin:
  - 47 dated non-birth events, from 1918 to 2024: Death 15, Residence 12, Graduation 7, Degree 4, Marriage 4, Divorce 2, Education 1.
  - 108 birth years.
  - Measured for 2026: a "multiple of 5 years ago" rule yields 42 items (27 of them births); a "multiple of 10" rule yields 24.
- Two blockers in the current export:
  - Event types are `{string:null, code:null}` for every exported event (D-02).
  - `date.sortValue` leaks day precision (D-01).
  - The feature therefore needs the record domain's fixed projection.

### 1.3 About
- The signed-in /about/ page ends at the last paragraph of the family-authored story (`11ty/about/index.html:129-160`).
- io: "the reason to exist for the logged in state ... should be a call to action".
- The story is family prose and is never rewritten by the build (`islands/copy.mjs:8-11`). The CTA must be new product copy in the DS voice.

### 1.4 Profile links
- No links store exists.
- The ETL emits no person `urls` (1 Url exists in Gramps, type WEB_SEARCH).
- `LINK#<email>` is already taken by the auth edge's link store (`docs/explanation/identity-model.md:85`).
- R-17 needs host rules that survive look-alikes:
  - `ig.com` is not Instagram.
  - `facebook.com@evil.example` parses to `evil.example`.
- io's no-contact-info rule (R-18) covers phone numbers and addresses. Links that open a direct message channel (`m.me`, `ig.me`, `wa.me`, `t.me`, `mailto:`, `tel:`, `sms:`) are contact channels.

### 1.5 Access requests
- Every `/api` route requires a session (`api/src/handler.js:80-81`, `api/src/routes.js:129`).
- The only anonymous write is forgot-password on the auth edge, which is rate-limited (`auth/src/edge.js:212-228, 336-339`, `auth/src/ratelimit.js:6-9`).
- The allowlist:
  - It is one S3 object, `config/userGrampsID.json`, read by the kit resolver (`iokit packages/auth/src/edge/deploy/resolver.ts:43-75`; `auth/edge.manifest.json` `resolver`).
  - io publishes it from local files, and **each publish overwrites the S3 object** (`docs/how-to/manage-family-access.md`, "The local files are the source of truth"). A Lambda that wrote that object would have its grants wiped by io's next publish.
  - No role can write `config/*` (`infrastructure/cloudformation/app-stack.yaml:88-105, 250-271`).
- A Cognito account exists only after a Google sign-in at `/auth/link` (`identity-model.md:57`, `auth/src/cognito.js:13-46`). An approved requester without a Google account for that email has no way to sign in today.
- Email:
  - No SES identity is configured; Cognito sends from `COGNITO_DEFAULT` at about 50 emails a day (`app-stack.yaml:31, 209-214`).
  - The Legacy Form requires an email, and the site has no other channel to reach a requester.
- IP-based rate limits:
  - `clientIp` prefers `CloudFront-Viewer-Address` (`ratelimit.js:65-76`).
  - Behind Cloudflare that is a Cloudflare egress address, so per-IP limits are shared across unrelated visitors.
- Gramps IDs cannot safely be minted in the cloud: no reserved prefix survives Reorder Gramps IDs (digest, gramps_id gap). A brand-new person waits for io's Gramps to assign the ID.

### 1.6 Photo tags
- Gramps holds 32 regions (integer-percent `[x1,y1,x2,y2]`) on 39 person media refs, covering 22 people on 23 photos.
- Tags per photo: 17 photos have 1 person, 4 have 2, 1 has 3 and 1 has 4.
- Of those refs, 21 sit on the person's primary photo.
- No ref has attributes, notes or citations. **Gramps has no "role" field on a tag.**
- The ETL drops every rect (`transform.py:309`).
- The gallery wraps each `img` in a `button.media-lightbox-trigger` (`11ty/js/person-page.js:573-583`), so nothing interactive can sit inside a thumbnail.
- `.gallery-photo` is letterboxed (`aspect-ratio: 4/5; object-fit: contain`, `islands/src/theme/45-person.css:389-398`), so percentages must be mapped onto the contained image, not the box.

---

## 2. Cross-cutting design

### 2.1 Flags and staging
- Every surface ships default-off in `11ty/_data/flags.json` (HFY-R8, HFY-R42).
- UAT runs with a session-scoped preview banner (HFY-R58), for example `?hfy_flags=navMe,onThisDay`.
- Islands load from the existing loader (`11ty/js/feature-flags.js:762-829`), one route regex per island.
- The anonymous edge routes also have a server-side kill switch, the Lambda env `ACCESS_REQUESTS` (stack parameter `AccessRequests`, default `off`). A client flag alone cannot stop an anonymous POST.

### 2.2 Shared pure modules (`shared/`)
Validators must run identically in the browser, in hfy-api and in the auth edge.
- **Where they live.** A new repo-root `shared/` holds zero-dependency ESM files:
  - `profile-links.mjs`
  - `legacy-form.mjs`
  - `onthisday-copy.mjs`
  - and, if the privacy domain has not created it yet, `contact-guard.mjs`
- **How each consumer gets them:**
  - `scripts/ci/package-api.sh` and `scripts/ci/package-auth.sh` copy `shared/` into the stage as `src/shared/`. Today the zip holds only `api/src` (`api/test/package-api.test.js:20-37`).
  - In the checkout, `api/src/shared` and `auth/src/shared` are committed relative symlinks to `../../shared`.
  - The islands import them by relative path, and esbuild bundles them.
- **A test enforces two rules:**
  - no bare import in `shared/`;
  - both zips contain `src/shared/*.mjs`.

### 2.3 `GET /api/me`
- The client has no admin signal: moderator status is inferred from `can.delete` (`docs/reference/front-end.md:420`).
- `GET /api/me` returns `{id, label, admin, badges}`:
  - `admin` is `actor.admin` from `config/admins.json` (`api/src/auth.js:45-48`).
  - `badges` appears only for admins, as `{accessRequests: <pending count>}`.
- The gear badge, the hub's admin rows and the requests page all use it. The moderation domain needs the same signal, so whichever task lands first owns it (risk R-9).

### 2.4 Voice rules applied everywhere (DS `guide/04-voice.md`)
- Lowercase sentence case, headings included. Person and place names keep their case.
- No exclamation marks. "page", never "record". "family", never "users" or "members".
- Feedback is a status ping: `saved`, `sent`, `posted`.
- Confirmations are one short question with the two real answers.
- Errors say what to do next: the `VOICE.error` pattern, "that didn't work. try again, or text {steward}."
- At most one emoji per string, end position, from the permitted set, never in headings or errors.
- Pride lines may take gold; status pings stay `text.dim`.
- Transactional email carries **no links**. It uses path notation instead ("open the family site, then settings → family requests"). This keeps the PSA true: "we will never email you a link to sign in."

### 2.5 Privacy invariants this domain enforces
- No birth month or day is shown, stored by this domain, or derived. The on-this-day builder asserts it even if its input carries one.
- Every free-text field runs the R-18 detector:
  - the Legacy Form fields;
  - the links, including URL paths;
  - the admin decline notes.
  - A phone number, street address or email outside the email field is a field error until removed.
- The access-request email lives only on:
  - the request item, until the retention TTL;
  - the allowlist entry, while access lasts.
  - It never reaches Gramps, a person page, a log line or an audit item.
- Logs never carry an email, a code, a ticket or a form value. Structured-log redaction has a test.

---

## 3. Nav rework (R-20, R-21)

### 3.1 Design

**Composition becomes a pure function.**
- A new file, `islands/src/lib/nav.js`, exports `navItems({ navMe, familyViz, notifyV2, sub })`. It returns the registry items, so every flag combination is testable in node.
- `shell.jsx` calls it instead of the inline `NAV.map(...)` at `:178`.
- `family-route.js` keeps `ownRoute`, `onOwnPage` and `navPathname`. Their meaning is now "the me tab".

| navMe | familyViz | Bottom bar / top links | Notes |
|---|---|---|---|
| off | off | home, family → own page, search, posts, me → settings | Today's behaviour. |
| off | on | home, family → `/tree/`, search, posts, me → settings | `viz.md` §10. The own page stays reachable from the avatar sheet. |
| **on** | off | home, search, posts, **me → own page** | 4 items. "family" leaves the bar until the tree exists, so "family" and "me" never both open the own page. |
| **on** | on | home, **family → `/tree/`**, search, posts, me → own page | 5 items, the cap. Order 1..5. |

**The "me" item.**
- Label `me`, icon the existing person glyph (`islands/src/shell.css:324-326`).
- Signed in: the route is `ownRoute(sub)`.
- Session pending or signed out: the route is the stable redirect `/private/`. `HFYFeatureFlags.goToFamily()` already sends a signed-in member to their own page and a signed-out visitor to sign-in and back (`11ty/js/feature-flags.js:616-640`).
- It is marked `aria-current` on the own page only, through the existing `navPathname`.
- The `/private/` title changes from "your family" to "your page" (`islands/copy.mjs:40`) in the flip task.
- **Cross-domain decision (SURF-D3).** `/private/` stays the own-page redirect. `viz.md` §10 step 3 proposed repointing `familyUrl()` to `/tree/`. `/tree/` is a public static page that needs no redirect, and "me" needs a session-independent stable route. `FAMILY_ROUTE`, `familyUrl` and `goToFamily` keep their names; the tests at `family-route.test.mjs:97-105` assert them.

**The gear.**
- A link `a.hfy-gear` in `.hfy-bar__end` (`shell.jsx:199`), before the account control.
- It appears only when the session is authenticated; settings need a session.
- `href="/me/"`, `aria-label="settings"`, `aria-current="page"` on `/me/` and its sub-paths.
- The icon is a single-weight gear drawn as a `currentColor` mask, like the nav icons (`shell.css:296-326`), gold when current.
- The `.hfy-bar__end` order is bell (notifications domain), gear, avatar. Each is 44×44 (`--io-shell-tap-min`).
- Admins see a dot on the gear when `badges.accessRequests > 0`. The aria-label becomes "settings, 2 family requests waiting".

**The account sheet** (`shell.jsx:151-157`) becomes: "your page", **"settings"** (→ `/me/`), "sign out". The "notifications" row moves into the hub. "your page" stays, because tests and muscle memory use it.

**The settings hub, `/me/`.**
- A repo-owned static page, `11ty/me/index.html`. It is registered in three places, like `/me/notifications/`:
  - `islands/heads.mjs:21-33` `PAGES`;
  - `islands/copy.mjs:118` `COPY_EXTRA`;
  - the `11ty/README.md` repo-owned list, plus the HFY-R46 Dropbox mirror and rsync exclude.
- Its island is `settings`. It loads on `/^\/me\/?(index\.html)?$/` when `navMe` is on.
- Rows: a list of 56px-high links, each with an icon, a label and one dim line.

| Row | Target | Line | Shown |
|---|---|---|---|
| notifications | `/me/notifications/` | "texts on this device, and what they're about" | always |
| your links | `/me/links/` | "facebook, instagram and the rest, on your page" | `profileLinks` |
| sign-in and devices | `/auth/link` | "google, password, face or fingerprint" | always |
| family requests | `/me/requests/` | "{n} waiting" / "nobody waiting" | admins and `accessRequests` |
| sign out | button (same `signOut()` as the sheet, `shell.jsx:121-132`) | | always |

- **Signed out:** one line, "sign in to change your settings.", with a sign-in link to `/auth/login?returnTo=%2Fme%2F`.
- **"sessions"** in io's brief maps to the kit's account page at `/auth/link`, which lists sign-in methods and passkeys. "Sign out on every device" has no kit edge support for Cognito sessions, so it is a backlog item (section 11), not a row.

### 3.2 UX
- **375 px:**
  - The bottom bar shows 4 cells of about 94 px, or 5 cells of 75 px once `familyViz` is on.
  - The top strip shows the brand and then `[bell][gear][avatar]`: 3 × 44 px plus two `space-2` gaps, about 148 px, which fits beside the brand inside 343 px.
  - The hub is a single column of full-width rows.
- **Desktop (≥ 43rem):** the top links render the same items in the same order. The gear sits at the right end of the bar. The hub is a 40rem column.

### 3.3 Tests
- **`family-route.test.mjs`:**
  - The NAV-shape test becomes a table over the four flag combinations through `navItems()`.
  - It keeps the gated-prefix assertion for every route, `/tree/` included.
  - The `aria-current` test now expects `me` on the own page with `navMe` on.
- **`shell.spec.mjs`:**
  - Labels become a function of flags.
  - With `navMe`, the 375 check expects 4 cells (and 5 with `familyViz`), the gear present only when signed in, and 44px targets.
  - The account sheet has "settings".
- **`family-route.spec.mjs`:** "me" goes to the own page; signed out, it goes to sign-in and back to the own page.
- **New `settings-hub.spec.mjs`:** rows by role (admin versus member), the signed-out state, axe clean, no horizontal scroll at 375.

---

## 4. On this day (R-14)

### 4.1 Approach
The data is sparse now and grows as members add dates. So the module is a **ladder of tiers**: it shows the best tier available today and always says which tier it is showing.

| Tier | Heading | Source | Today |
|---|---|---|---|
| day | "on this day" | non-birth events with month and day equal to today | 2 death items in the year |
| week | "this week in family history" | non-birth events within ±3 days | 2 death items, 7 days each |
| year | "this year in family history" | milestone years: years ago n = Y − year, where n % 5 = 0 for non-birth events and n % 10 = 0 or n ∈ {25, 75} for birth years; at least 10 | 42 items (2026) |
| archive | "from the family's posts" | published posts and photos created on this date in a past year (live query) | none yet; grows from 2027 |
| prompt | — | invites a date: "know the day …? add it." | always available |

**How a day is composed.**
- Take the first non-empty tier of day, week and year. Show up to 3 items from it.
- Then add at most 1 archive card, then a prompt if fewer than 2 items showed.
- **Year-tier rotation.**
  - The order is a deterministic shuffle seeded by `sha256(date)`, so each day differs but a reload is stable.
  - Ranking: n % 25 = 0, then n % 10 = 0, then n % 5 = 0.
  - Constraints: distinct people, varied kinds, at most 1 commemorative item.

**How it grows.**
- When members add a month and day to marriages, graduations and deaths through the editing and proposal flows (R-06, R-08, R-09), the next index rebuild moves those events into the day and week tiers automatically.
- The prompt deliberately picks a year-tier celebratory item that lacks a day ("know the day they got married? add it to their page."). The module thereby feeds data completion.
- As posts accumulate, the archive tier fills each anniversary.

### 4.2 Tone and copy rules (DS voice)
- **Tone per kind** (index field `tone`):
  - `celebrate`: marriage, graduation, degree, education, and the birth milestones of people the record store marks `living`.
  - `neutral`: residence ("moved to"), birth milestones of anyone else.
  - `remember`: death, and burial or cremation only when no death event exists.
- **Never shown:** divorce, annulment, any birth month or day, anything whose person or event has the Gramps `private` flag, and anything hidden (§4.5).
- **Celebrate:**
  - One plain line. Gold is allowed on the pride accent.
  - At most one emoji in the whole module, end position, only on a celebrate item with n ≥ 50, from {❤️ marriage, 👏🏾 graduation/degree}.
- **Remember:**
  - Ink colour, never gold, no emoji, no "happy", no "celebrate", no "anniversary".
  - It is grouped after celebrations under a quiet `remembering` label, and never mixed into a celebratory sentence.
- **Living people** get only celebrate or neutral items. "turns {n} this year" is used only when `lifeState = living` and n ≤ 100. Otherwise the neutral "was born {n} years ago, in {y}" avoids awkward ages for people the 92% "no death event" heuristic misclassifies.
- **One person appears at most once per day.** Plurals are correct ("1 year", "2 years").

**Copy deck** (`shared/onthisday-copy.mjs`; `{a}`, `{b}` and `{name}` are display names in `font.display`; `{when}` ∈ today | this week | this year):

| kind / tone | template |
|---|---|
| marriage / celebrate | `{a} and {b} got married {n} years ago {when}.` |
| graduation / celebrate | `{name} graduated{ from {detail}} {n} years ago {when}.` |
| degree / celebrate | `{name} earned {detail or "a degree"} {n} years ago {when}.` |
| education / celebrate | `{n} years ago {when}: {name}, {detail}.` |
| birth, living ≤100 / celebrate | `{name} turns {n} this year.` |
| birth, other / neutral | `{name} was born {n} years ago, in {y}.` |
| residence / neutral | `{name} moved to {place} {n} years ago {when}.` (skipped without a place) |
| death, day / remember | `remembering {name}, who died {n} years ago today.` |
| death, week / remember | `remembering {name}. {n} years ago this week.` |
| death, year / remember | `it's been {n} years since we lost {name}.` |
| post archive | `a year ago today, {author} posted:` / `{n} years ago today, {author} shared a photo.` |
| prompt, targeted | `know the day {a} and {b} got married? add it to their page.` |
| prompt, generic | `no dates for today yet. know when something happened in the family? add it to someone's page.` |

- The heading is `on this day`, `this week in family history` or `this year in family history`. The date line in `text.dim` uses the DS format (`oct 13`).
- A footer link reads "see the family" → `/search/` (later `/tree/`).

### 4.3 Data artifact: the gated month-day index
- **Where it lives.** One DynamoDB item, `PK=OTD#INDEX`, `SK=V1`. It is served only through the session-checked API, so it is gated by the same rule as every `/api` route.
- **Why not S3:**
  - no new IAM;
  - no new CloudFront prefix, and none of the four-list problem from digest map 1;
  - no collision with `aws s3 sync --delete` on `person/`;
  - and the conditional build lease lives on the same item.
- **Body:** gzip JSON in the binary attribute `body`. About 170 items is about 60 KB raw and about 10 KB compressed, far under the 400 KB item limit. At more than 300 KB compressed the builder shards by month (`SK=V1#MM`) and the reader merges.

```json
{
  "schema": "hfy.onthisday.v1",
  "generatedAt": "2026-10-13T09:00:00Z",
  "sourceVersion": "<record-store change seq | person/index.json ETag>",
  "policyVersion": "r19-1",
  "day":   { "10-13": [Item] },
  "month": { "10": [Item] },
  "year":  [Item]
}
```
`Item = { id: "evt:<handle>" | "birth:<grampsId>", kind, tone, year, month?, day?, people: [{ grampsId, name, lifeState: "living"|"deceased"|"unknown" }], place?: "<city-level displayName>", detail?: "<event description, R-18 scanned>" }`.

**Builder** (`api/src/onthisday/build.js`, pure: `buildIndex(source, { policyVersion }) → index`).
- **Input** is the record store's event projection: `{handle, typeCode, date: {year, month?, day?, modifier, quality}, participants: [{grampsId, role}], place, description, private}`, plus persons `{grampsId, displayName, lifeState, private}`.
- **Type codes** come from the Gramps `EventType`: BIRTH 12, DEATH 13, MARRIAGE 1, DIVORCE 7, DEGREE 25, EDUCATION 26, GRADUATION 31, RESIDENCE 42, BURIAL 19.
- **Dates:**
  - Only `modifier ∈ {0 NONE, 7 FROM}` with `quality 0` is used. About, before, after, range and estimated dates are skipped.
  - Birth items keep the year only. The builder **drops** any month or day on a birth and counts it in `report.droppedBirthPrecision`. A test asserts the output contains no birth month or day even when the input carries one, as defence in depth for R-19.
- **Participants.** Marriage people come from the event's Bride/Groom/Family roles. 4 marriage events are attached to persons with Bride and Groom roles (digest map 2).
- **The source adapter is an interface, `OnThisDaySource { version(): string, events(): AsyncIterable, persons(): AsyncIterable }`:**
  - (a) the record-store adapter, owned by the sync/record domain, with `version` = its change-log sequence;
  - (b) an **interim** adapter over the published `person/index.json` and `person/<id>.json`. `version` is the ETag of `person/index.json`; reads run 16 at a time. It gives the year tier only, needs D-02's event types, and never sees a month or day once D-01 strips `sortValue`.

**Lazy rebuild, with no scheduler.**
1. `GET /api/onthisday` reads the item.
2. If it is missing, or `sourceVersion ≠ source.version()` and no live lease exists, it takes a lease: `UpdateItem SET buildingUntil = now+60s` with `ConditionExpression: attribute_not_exists(buildingUntil) OR buildingUntil < :now`.
3. It rebuilds, then puts the new body with `ConditionExpression: buildingUntil = :mine`.
4. It serves the result.
- If the build fails, the stale body is served with `stale: true`. With no body at all, the answer is 503 and the island renders nothing.
- A parsed copy is cached in Lambda memory for 5 minutes, keyed by `sourceVersion`.

### 4.4 API
`GET /api/onthisday?date=YYYY-MM-DD&tzOffset=<minutes>` (session; route name `onthisday.get`; no MCP tool).

```json
{
  "date": "2026-10-13", "tier": "year",
  "items": [{ "id": "evt:...", "kind": "graduation", "tone": "celebrate", "when": "year", "n": 20, "year": 2006,
              "people": [{ "grampsId": "I....", "name": "..." }], "place": null, "detail": "..." }],
  "posts": [{ "id": "<ulid>", "n": 1, "author": { "id": "I....", "label": "..." }, "excerpt": "...", "photo": { "url": "...", "alt": "..." } }],
  "prompt": { "kind": "add_day", "itemId": "evt:...", "people": [{ "grampsId": "I....", "name": "..." }] },
  "indexVersion": "...", "stale": false
}
```
- **Past-year posts:**
  - Posts are indexed under `GSI1PK=POSTS` with `GSI1SK=<ulid>` (`api/src/content.js:93`), so a past local day is one key range.
  - For each past year Y back to 2025, one Query: `GSI1SK BETWEEN ulidFloor(dayStart(Y)) AND ulidCeil(dayEnd(Y))`, with `dayStart` and `dayEnd` derived from `tzOffset`.
  - Only `visibility = published` is kept.
- **Selection** is the pure function `selectOnThisDay(index, { date, posts, hidden })` in `api/src/onthisday/select.js`. Copy is rendered on the client from `shared/onthisday-copy.mjs`, so the voice lives in one place and is unit-tested.
- **`POST /api/onthisday/hide`** `{itemId}` → 204. Allowed for an admin, or for a member whose own grampsId is among the item's people. It writes the item id into `OTD#HIDDEN / META {ids:[...]}` with an `AUDIT#otd` item, op `onthisday.hide`. `DELETE /api/onthisday/hide/:itemId` is admin only.
- **Errors:**
  - 400 `validation`: bad date, or `tzOffset` outside ±840.
  - 401 signed out.
  - 403 hide not allowed.
  - 503 `unavailable`: no index and the build failed.

### 4.5 UX
- **Placement.**
  - The island `onthisday` is loaded by `feature-flags.js` on `/` with `onThisDay`.
  - It mounts in a host inserted **after `section.home-hero`** in the page's own `<main>`. Ordering is then deterministic against the timeline island, which appends to `main` (`islands/src/islands/timeline.jsx:34`).
  - Signed out it renders nothing, as the timeline does (`timeline.jsx:23-31`).
- **Card.**
  - `surface.raised`, `radius.lg`.
  - h2 `.hfy-h` with the tier heading, and a date line in `text.dim`.
  - Each row: a 24px single-weight kind glyph (ring, cap, house, leaf for `remember`) as a currentColor mask, the sentence with names linked to `/person/?id=`, and a dim `{year} · {n} years ago`.
  - The `remembering` label and its rows come last.
  - Each row has a "hide this" overflow (a 44px icon button) for an admin or a person in the item: "hide this from on this day?" → `hide` · `keep`.
- **375 px:** full-width card. Rows wrap. Targets are 44px. At most 3 rows plus 1 archive card; a "more from this week" disclosure appears only in the week tier.
- **Desktop:** same card in the content column (max 40rem measure). The archive card shows the photo thumbnail at 96px.
- **Loading and failure:**
  - A one-row skeleton while loading.
  - A network or 503 failure removes the section (no error banner on the public homepage, as in `timeline.jsx`).
  - A `stale: true` response renders normally.

---

## 5. About CTA for signed-in members (R-15)

### 5.1 Design
- **Island and mount.**
  - The island is `about-cta`. It loads on `/^\/about\/?(index\.html)?$/` with `aboutCta`.
  - It mounts in a host inserted after `section.about-hero` (`11ty/about/index.html:129-160`).
  - It renders only when `edgeSignedOut() === false` (`islands/src/lib/api.js:13-26`).
  - Signed out with `accessRequests` on, it renders a one-line variant instead: "family, but not signed in yet? sign in. new here? ask to join." (§7).
- **Data:**
  - Uses `HFYFeatureFlags.dataFetch` (gated, HFY-R66).
  - `/person/index.json` gives the counts: `people.length`, `noPhoto` = rows without `primaryPhoto`, `noBirthYear` = rows with `birthYear == null`.
  - `/person/<sub>.json` gives the member's own gaps: no primary photo, no birth event or year, no birthplace, no notes.
  - Optional: the contributions domain's monthly count (R-25), shown only if its API answers and n ≥ 3.
- **Deep links:**

| card | target | change needed |
|---|---|---|
| look around | `/search/` (`/tree/` once `familyViz` is on) | none |
| add what's missing | `/search/?has_birth_year=false` | the search island seeds property tokens from URL params; new corpus property `has_birth_year` (`islands/src/lib/people-corpus.js:60-79, 98-106`; `islands/src/islands/search.jsx:100-104`) |
| fix what's wrong | `/person/?id=<sub>` ("start with your page"); every page carries the proposals domain's "suggest a fix" | none here |
| add photos | `/search/?has_photo=false`; own-page action `/person/?id=<sub>#share` | the my-posts composer section gets `id="share"`, and on `#share` it scrolls in and focuses (`islands/src/islands/my-posts.jsx:91-96`) |

The search URL contract is: `has_photo`, `has_birth_year` and `living` accept `true|false`, and unknown params are ignored. The filter pills show the active filter, so the deep link is visible and removable.

### 5.2 Copy (DS voice; product copy, lowercase; the family story above stays untouched)
- A hairline divider, then:
- **h2** (display serif): `the story isn't finished.`
- **lede:** `it keeps going with every name, date and photo the family adds. a lot of pages are still thin, and you probably know something that isn't here yet.`
- **Optional line:** `{n} family members added something this month.`
- **Personal nudge** (only if the member's own page has gaps): `your page is missing {a photo | a birth year | a birthplace | a story}. start there?` → "open your page".
- **Cards** (title / line / action):
  1. `look around` / `{people} people so far. find someone you remember.` / `open the family`
  2. `add what's missing` / `{noBirthYear} people don't have a birth year yet. know one? add it.` / `see who's missing a year`
  3. `fix what's wrong` / `see a wrong date or a misspelled name? open that page and suggest a fix. we check it before it changes.` / `start with your page`
  4. `add photos` / `{noPhoto} people don't have a photo yet. a phone photo of an old print counts.` / `add a photo`
- **Closing:** `the memories live on.` This is verbatim from the voice guide's stewardship bank (rule 6: quoted, not invented).
- **Copy checks:** no "record", no exclamation, no "users" or "members". Numbers are digits. When a count is 0 the card swaps in a neutral line, for example `every page has a photo. nice work, family.`

### 5.3 UX
- **≥ 64rem:** heading and lede in the 7-column copy measure, cards in a 2×2 grid. Each card is one link (the whole card, at least 44px), titled at 18px in `font.ui`, with the line in `text.dim`.
- **43–64rem:** 2×2.
- **375 px:** one column, cards full width, nudge above the cards.
- **Loading:** skeleton cards.
- **Count fetch fails:** the cards render without numbers (the lines have count-free variants).
- **Own record fails:** the nudge is omitted.

---

## 6. Profile links (R-16, R-17)

### 6.1 Decisions
- **Storage.** Links are member-owned cloud data in DynamoDB, **not Gramps `Url`**.
  - Gramps `Url` sits with contact-like data (EMAIL is a UrlType), so links never sync to Gramps.
  - The one existing WEB_SEARCH Url stays Gramps-only.
- **Contact info.** Public social profile links are allowed: io asked for them in the same prompt that set the contact rule. Email and phone are not allowed. Contact-channel links are rejected everywhere (SURF-D9).
- **Who edits.** The owner (`actor.id === :id`) edits directly; this is the R-09 "own information" rule. An admin may clear a link (moderation). Nobody else can write, and there are no link proposals in v1.
- **Short links and share links are rejected**, not resolved. Resolving them would mean an outbound fetch, which carries SSRF and privacy risk. The error copy asks for the profile's own address.

### 6.2 Validator (`shared/profile-links.mjs`, the single source for API and UI)

**Pipeline** for each field:
1. Trim the input, maximum 300 characters.
2. **Handle input** (`@name` or a bare token) is accepted for instagram, tiktok, snapchat, linktree and facebook (username), and for linkedin (`/in/` slug).
3. **URL input:**
   - Prefix `https://` when there is no scheme.
   - Parse with WHATWG `URL`.
   - Accept only `http:` and `https:`.
   - Reject userinfo and non-default ports.
   - Lowercase the host and strip a trailing dot.
   - Match domains **by suffix only** (`host === d || host.endsWith("." + d)`).
4. **Platform fields:**
   - The host must be a **profile host**: not a CDN, link shim, video, short-link or contact host.
   - The path must match a profile shape.
   - Query and fragment are stripped, except Facebook's `profile.php?id=<digits>`.
   - Tracking params are dropped.
   - The output is a canonical URL plus a display handle.
5. **Website field:**
   - Rejected for any domain of the six platforms (all hosts, including CDN, short and contact hosts).
   - Also rejected: generic shorteners (bit.ly, tinyurl.com, t.co, ow.ly, buff.ly, rebrand.ly, is.gd, cutt.ly, shorturl.at, goo.gl, s.id), IP-literal hosts, `localhost`, and `.local`, `.internal` and `.home.arpa` hosts.
   - Accepted: any other public host. Display is the ASCII hostname (punycode), never a Unicode look-alike.
6. **Everywhere:**
   - Contact channels are rejected: `mailto:`, `tel:`, `sms:`, `wa.me`, `api.whatsapp.com`, `t.me`, `m.me`, `messenger.com`, `ig.me`, `instagram.com/m/…`.
   - The R-18 detector runs on the decoded path and on handles, so a 7+ digit run shaped like a phone number is rejected.

| platform | profile hosts (suffix match) | profile path shapes | handle rule | canonical |
|---|---|---|---|---|
| facebook | facebook.com (`www`, `m`, `mbasic`, `touch`, `web`) | `/<username>` (5–50, `[A-Za-z0-9.]`), `/profile.php?id=<digits>`, `/people/<name>/<digits>/` | username | `https://www.facebook.com/<username>` or `…/profile.php?id=<n>` |
| instagram | instagram.com (`www`, `m`) | `/<username>/?`; reserved first segments rejected: `p`, `reel`, `reels`, `explore`, `accounts`, `stories`, `m`, `direct`, `share` | `[A-Za-z0-9._]{1,30}` | `https://www.instagram.com/<u>/` |
| tiktok | tiktok.com (`www`, `m`) | `/@<username>` | `[A-Za-z0-9._]{2,24}` | `https://www.tiktok.com/@<u>` |
| snapchat | snapchat.com (`www`) | `/add/<u>`, `/@<u>` | `[A-Za-z][A-Za-z0-9._-]{2,14}` | `https://www.snapchat.com/@<u>` |
| linkedin | linkedin.com (`www` and country subdomains) | `/in/<slug>`; legacy `/pub/<…>` refused with a hint to use the `/in/` address (P2-R17); `/company/` rejected (SURF-D8) | `[A-Za-z0-9-]{3,100}` | `https://www.linkedin.com/in/<slug>` |
| linktree | linktr.ee, linktree.com | `/<username>` | `[A-Za-z0-9._]{2,30}` | `https://linktr.ee/<u>` |
| website | any host except all of the above, shorteners, contact hosts, IPs and local names | any | — | as typed, with the scheme defaulted to https |

**Hosts recognised but never accepted as profiles** (the error points the member to the right field or shape):
- `fb.com`, `fb.me`, `fb.watch`, `l.facebook.com`, `lm.facebook.com`, `facebook.net`, `fbcdn.net`
- `instagr.am`, `cdninstagram.com`
- `vm.tiktok.com`, `vt.tiktok.com`, `tiktokv.com`, `tiktokcdn.com`, `www.tiktok.com/t/…`
- `t.snapchat.com`, `snap.com`
- `lnkd.in`, `linkedin.cn`

`ig.com` is **not** Instagram and is accepted as a website. Host data comes from `pln2/profile-links-registry.json` (live probes, 2026-10-13).

**Error codes** (field-scoped):
- `invalid_url`
- `scheme_not_allowed`
- `wrong_platform` (carries `suggest: "<platform>"`)
- `not_a_profile`
- `short_link`
- `contact_channel`
- `contact_info` (R-18)
- `too_long`
- `invalid_handle`

### 6.3 Data and API
- **Item:** `PK=PLINKS#<gramps_id>`, `SK=META`, `{links: {facebook?: {url, handle}, instagram?: …, website?: {url, host}}, version: <int>, updatedAt, updatedBy}`.
  - No GSI.
  - Every write is a `TransactWriteItems` of the item plus an `AUDIT#plinks:<gramps_id>` item, op `links.update` or `links.clear`, with before and after (D-15).
- **`GET /api/people/:id/links`** (session) → `200 {links, version, can: {edit}}`, or `{links:{}, version:0}` when there is no item.
  - `:id` is checked with `^[A-Za-z0-9_-]{1,64}$` (`api/src/labels.js:12`).
- **`PUT /api/people/:id/links`** `{links: {<platform>: string|null}, version}`:
  - Owner: may set or clear any platform. Admin: may only clear (`null`).
  - `200 {links, version}`.
  - `403 forbidden`.
  - `409 conflict` (`version` mismatch; the body carries the current item).
  - `422 validation`, `details: {fields: [{field, code, suggest?}]}`.
  - The API error mapper gains `details.fields` (`api/src/http.js:15-31`), and `ApiError` keeps it (`islands/src/lib/api.js:34-56`).
- No MCP tool.

### 6.4 UX
- **Display.**
  - The island is `person-links`. It loads on `/person/?id=` with `profileLinks`.
  - It waits for `.person-heading` (the `person.jsx:16-26` pattern) and appends `ul.person-links[aria-label="links"]` under the lifespan line (`person-page.js:318-343`).
  - **Chip:** a mask icon plus text. Platforms with handles show `@handle`; facebook and linkedin show the platform name; website shows the hostname. The link carries `target="_blank" rel="noopener noreferrer nofollow ugc" referrerpolicy="no-referrer"` and `aria-label="instagram: @handle (opens in a new tab)"`.
  - **Owner:** an extra chip, "edit links", or "add your links" when empty, → `/me/links/`.
  - **Visitor and no links:** nothing renders.
  - **375 px:** chips wrap, 44px high, `space-2` gaps. **Desktop:** one inline row.
- **Editor, `/me/links/`.**
  - A repo-owned page with island `links-editor`. Seven labelled 16px inputs: facebook, instagram, snapchat, tiktok, linktree, linkedin, website.
  - Each input: hint `@yourname, or the link to your profile`; `inputmode="url"`, `autocapitalize="none"`, `spellcheck="false"`, `autocomplete="off"`.
  - It validates on blur with the shared module, and on save with the API.
  - "remove" per field. One "save" button, then the ping `saved`.
- **Field errors (voice):**
  - `that's an instagram link. move it to instagram?` with a `move it` button.
  - `that's a share link. open your profile and copy the address from there.`
  - `that's a way to message someone, not a profile. use your profile's address instead.`
  - `that looks like a phone number. take it out, then save.`
- On a 409 the editor reloads the latest version with `someone changed this a moment ago. here's the latest.`

---

## 7. Access-request sign-up (R-23, R-42)

### 7.1 Flow and states
```
/join/ (public, island "join")
  step 1  email + Turnstile + honeypot  --POST /auth/access-request/start-->  202 always (no enumeration)
          edge emails ONE of: a 6-digit code | "you're already on the list" | "we already have your request"
  step 2  6-digit code                  --POST /auth/access-request/verify--> 200 {ticket}  (proves the mailbox)
  step 3  Legacy Form S1 + S2 + "this is about me"  --POST /auth/access-request--> 201 received
          edge writes ACCESSREQ#, emails "we got your request", writes admin inbox items, emails admins (no details)
admin  /me/requests/ (island "access-requests", admin only)
          link to an existing person   -> allowlist entry written -> state active  -> email "you're in"
          they're new                  -> state awaiting_record (person-create proposal) -> link later -> active
          decline (+ optional note)    -> state declined -> email
```
State machine for `ACCESSREQ#<id>.state`:
- `pending → active` (link)
- `pending → awaiting_record` (new) `→ active` (link once a gramps_id exists)
- `pending → declined`
- `pending → expired` (TTL)
- `active → revoked` (admin removes access)

**Why verify the email first.**
- A typo'd Gmail address that an admin approves would let a stranger sign in with Google and read private family data. Proving the mailbox closes that hole.
- Every later email then goes to a proven inbox.
- The edge can tell the mailbox owner, and only them, that they are already a member.
- The code email is the only mail an anonymous visitor can trigger. It carries the per-email, per-IP and global limits below.

### 7.2 Edge routes (anonymous, `auth/src/access-request.js`, wired in `createAuthEdge` before the kit fall-through at `edge.js:336`)

Every route requires:
- `POST`
- `content-type: application/json`
- `x-requested-with: io-kit`
- `Origin` equal to the site, the same CSRF posture as forgot-password (`edge.js:212-216`)
- `ACCESS_REQUESTS=on`; otherwise `503 {detail:"closed"}`

| route | body | success | failures |
|---|---|---|---|
| `GET /auth/access-request/config` | — | `200 {open, turnstileSiteKey}` | — |
| `POST /auth/access-request/start` | `{email, turnstileToken, company}` | `202 {ok:true}` | `400 {detail:"invalid_email"}`; `403 {detail:"bot_check_failed"}`; `429 {detail:"rate_limited"}` + `retry-after`; `503 {detail:"unavailable"}` (limiter, SES or Turnstile down: fail closed) |
| `POST /auth/access-request/verify` | `{email, code}` | `200 {ticket, expiresAt}` | `400 {detail:"invalid_code"}`; `410 {detail:"code_expired"}`; `429 {detail:"too_many_attempts"}` |
| `POST /auth/access-request` | `{ticket, form, turnstileToken, company}` | `201 {ok:true, state:"pending"}` | `400 {detail:"validation", fields:[{field, code}]}`; `401 {detail:"ticket_expired"}`; `409 {detail:"already_requested"}` or `{detail:"already_member"}` (safe: the ticket proves the mailbox); `429`; `503` |

**Start step.**
- Normalize the email (lowercase, trim; RFC-lite, at most 254 characters).
- A non-empty honeypot `company` gets a silent `202` with no work done.
- Verify Turnstile: `siteverify` with `secret`, `response`, `remoteip`; require `success`, `hostname=harrisonfamily.us` and `action="join"`; 3 s timeout, which fails closed.
- Run the rate limiters (§7.5).
- Look up the allowlist with the composite resolver (§7.6):
  - **member** → send the "already on the list" email;
  - **open request** → send "we already have your request";
  - **otherwise** → write `ACCESSCODE#` and send the code.
- Always answer `202` after comparable work, so the response does not reveal membership.

**Code.**
- 6 digits from `crypto.randomInt`.
- Stored as `HMAC-SHA256(pepper, email + ":" + code)`.
- Lives 15 minutes, allows 5 attempts, then is deleted.
- A resend is allowed after 60 s and is rate-limited.

**Ticket.**
- 32 random bytes, base64url, returned once.
- Stored as `ACCESSTICKET#<sha256(ticket)>`, bound to the email.
- Lives 60 minutes and is single-use at submit (conditional delete).

**Submit step.**
1. Validate with `shared/legacy-form.mjs` (§7.3).
2. Run the R-18 detector on every free-text field.
3. In one `TransactWriteItems`:
   - Put `ACCESSREQ#<ulid>`;
   - Put `ACCESSREQEMAIL#<emailHash>` with the condition `attribute_not_exists(PK) OR #state IN (:declinedOld, :expired)`;
   - Delete the ticket.
   - Plus an `AUDIT#accessreq:<ulid>` item, op `accessreq.submit`. It holds no PII: `{id, state}` only.
4. Post-commit, best effort: email the requester "we got your request"; write one inbox item per admin through the notifications domain's shared builder (title "someone asked to join."); email each admin address "someone asked to join the family site. open the family site, then settings → family requests." with no details and no link.

**Admin email addresses.**
- Computed by inverting the allowlist for the gramps_ids in `config/admins.json`: the S3 file plus `ALLOW#` through `GSI1PK=ALLOWSUB#<sub>`, first match per sub, sorted.
- The edge already reads both files (`auth/src/membership.js:5-29`).

### 7.3 Form, validation and the Gramps mapping (`shared/legacy-form.mjs`)
Wording follows the Legacy Form screenshots (digest gap fill), adapted to the voice. `REQ` = required.

| key | field (UI label) | rule | Gramps 6.0.6 mapping |
|---|---|---|---|
| `email` | your email (step 1) | REQ, RFC-lite, ≤254, equals the ticket's email | **not mapped**; allowlist key only |
| `givenNames` | your given names (first and middle, like on your birth certificate) | REQ, 1–100, `^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$`u, single spaces | `Person.primary_name.first_name`, the exact string (one field, per the name-model finding) |
| `maidenSurname` | your last name at birth | REQ, 1–60, same charset | `primary_name.surname_list[0] = {surname, primary:true}`; `primary_name.type = BIRTH (2)` |
| `gender` | gender | REQ, `male\|female\|other` | `Person.gender`: male 1, female 0, other 3 (`gender.OTHER`, Gramps `person.py:86-89`) |
| `genderOther` | other (optional text) | ≤40, R-18 | not mapped; shown to the admin and scrubbed with the request |
| `nickname` | what does the family call you? | optional, ≤40, R-18 | `primary_name.nick` |
| `birthPlace` | where were you born? city and state | REQ, ≤100, R-18, no run of 3+ digits, no street-suffix pattern | Birth event `place`: an existing Place matched by city plus state (state abbreviations expanded), else a proposed new Place (City under State under Country) |
| `birthYear` | what year were you born? (just the year. we never ask for your full birthday.) | REQ, `^(19\|20)\d{2}$`, ≤ current year, ≥ current year − 110 | Birth event, type BIRTH (12), `date = {dateval:[0,0,Y,false], modifier:0, quality:0}`, `EventRef.role = PRIMARY (1)`, `birth_ref_index` → it. **Year only (R-19).** |
| `currentPlace` | where do you live now? city and state is plenty | REQ, same as `birthPlace` | Residence event (42), place matched as above |
| `movedYear` | what year did you move to your region? (moving a few counties over doesn't count) | optional, year regex, ≥ birthYear, ≤ current year | the Residence date: `modifier FROM (7)`, year only |
| `university` | if you graduated from a university, which one? | optional, ≤120, R-18 | Graduation event (31), `description = university`, no place |
| `graduationYear` | what year did you graduate? | optional, year regex, ≥ birthYear + 10, ≤ current year | the Graduation date, year only |
| `otherDegrees` | any other degrees? | optional, ≤200, R-18 | Degree event(s) (25), `description = otherDegrees · otherInstitutions` |
| `otherInstitutions` | from which school(s)? | optional, ≤200, R-18 | (folded into the description above) |
| `otherDegreeYears` | in what year(s)? | optional, comma or space list, each matches the year regex, ≤5 | one Degree event per year, else one undated; marked `needsReview` |
| `everMarried` | were you ever married? | optional (no required marker on the form): `married_once_still\|married_once_widowed\|married_once_divorced\|married_more_than_once\|never_married` | **not mapped**. The family structure comes from the relationship proposals (R-24). After approval the new member's own page shows "tell us about your spouse". |
| `forSelf` | this is about me, not someone else | REQ `true` | — |
| `company` | (honeypot, hidden) | must be empty | — |

- `mapToGramps(form) → {person, events[], placeQueries[]}` is pure and returns Gramps-6 `_class`-tagged JSON fragments. The admin UI shows it as an editable preview.
- Place matching runs client-side in the admin UI against the gated `/place/index.json`. No new API IAM is needed.
- **Year validation note.** The `^(19|20)\d{2}$` regex comes from DOC-2CFAE07B546C Appendix A; the screenshots do not show it. It is applied with the extra bounds above.
- **Living current city.** The residence is city-level only (SURF-D16, io's call). Street addresses and ZIP codes are rejected.

### 7.4 Admin API (session, admin) and decisions

| route | body / query | success | failures |
|---|---|---|---|
| `GET /api/access-requests` | `?state=pending\|awaiting_record\|done&cursor=` | `200 {items:[{id, state, createdAt, givenNames, maidenSurname, birthYear, birthPlace}], cursor}` | 401, 403 |
| `GET /api/access-requests/:id` | — | `200 {id, state, version, email, form, preview, decision?}` | 401, 403, 404 |
| `POST /api/access-requests/:id/decision` | `{decision:"link", grampsId, version, allowSecondEmail?}` · `{decision:"new", preview, version}` · `{decision:"decline", note?, sendNote?, version}` | `200 {state, emailSent}` | 400 `validation`; 403; 404; 409 `conflict` (version, or the state forbids it); 409 `already_member` (the email is already active); 409 `second_email` (that person already has access with another email: retry with `allowSecondEmail:true`); 422 `unknown_person` (grampsId not in `person/index.json`) |
| `POST /api/access-requests/:id/revoke` | `{version, reason?}` | `200 {state:"revoked"}` | 403, 404, 409 |

**Link.**
- One `TransactWriteItems`:
  - Put `ALLOW#<email>` (`{sub, state:"active", source:"access-request", requestId, at, by}`, `GSI1PK=ALLOWSUB#<sub>`), with the condition `attribute_not_exists(PK) OR #state = :revoked`;
  - Update `ACCESSREQ#` with `#state = :expected AND #version = :v`, setting `state = active`, `decision` and `ttl = now + 30 d`;
  - an `AUDIT#accessreq:<id>` item, op `accessreq.decide`;
  - an `AUDIT#allow:<emailHash>` item, op `allow.grant`. Audits carry the sub and the emailHash only.
- This needs the `transact()` Update and ConditionCheck support (`api/src/txn.js:32-38`), the `dynamodb:ConditionCheckItem` permission, and the fake-ddb test double.
- **Post-commit:**
  - email "you're in";
  - inbox "{admin} let {name} in." to the other admins;
  - if the form adds facts the person's page lacks (nickname, birthplace, residence, education), a `person.update` proposal through the proposals domain, `origin: {type:"access_request", id}`, which an admin reviews like any other.
- Only Gramps-mapped facts move. The email never does.

**New.**
- State becomes `awaiting_record`.
- Calls the proposals domain's `createSystem({kind:"person.create", payload: preview, origin})` and stores `proposalId`.
- When the record store assigns a gramps_id, it calls `completeAccessRequest(requestId, grampsId)`, which performs the link transaction above.
- Until that hook exists, io creates the person in Gramps, publishes, and presses **link** on the awaiting card.
- The cloud never mints a gramps_id (digest, gramps_id gap, option a). Email: "you're approved. we're adding you to the family tree now. we'll email you again when you can sign in."

**Decline.**
- State becomes `declined`, with `ttl = now + 30 d`.
- The optional note is ≤500 characters and R-18 scanned. It is emailed only when `sendNote` is set.

**Revoke.**
- Update `ALLOW#` to `state = revoked`, `ACCESSREQ#` to `revoked`, plus an audit item. No email.
- Access ends at the next allowlist resolution (sign-in or refresh). An open `io_id` lives at most 1 hour (`auth/edge.manifest.json` `accessTtlSeconds`).

**Approver.**
- `actor.admin` (`config/admins.json`) is empty today (HFY-R70, R73). io must name approvers (SURF-D14).
- Web approvals use no step-up in v1. They are audited, reversible, and every admin is told (SURF-D19).

### 7.5 Abuse protection
- **Turnstile** (Cloudflare, managed or invisible mode, `action=join`) guards `start` and the final submit.
  - The widget and secret are created by io in the Cloudflare dashboard, outside the repo.
  - The secret lives in Secrets Manager as `harrisonfamily/auth-edge/turnstile`.
  - Site pages have no CSP today, so the `challenges.cloudflare.com` script loads on `/join/`. No new third party is added: Cloudflare already fronts the site.
- **Honeypot:** a hidden `company` field (off-screen, `tabindex=-1`, `aria-hidden`, `autocomplete=off`). When it is filled, the server answers success and does nothing.
- **Rate limits.** These reuse `ddbRateLimiter` and `rateKey` (`auth/src/ratelimit.js:18-40`). Keys are hashed, so no email or IP is stored.

| name | scope | limit / window |
|---|---|---|
| `joincode` | email+ip | 3 / 1 h |
| `joincode` | email | 5 / 24 h |
| `joincode` | ip | 10 / 24 h |
| `joincode` | global | 50 / 24 h |
| `joinverify` | email | 10 / 1 h (plus 5 attempts per code) |
| `joinsubmit` | ip | 5 / 24 h |
| `joinsubmit` | global | 20 / 24 h |
| open queue | global | at most 100 `pending`; above that, `503 {detail:"queue_full"}` |

- **Client IP behind Cloudflare.**
  - `clientIp` today trusts `CloudFront-Viewer-Address` (`ratelimit.js:65-76`). Behind Cloudflare that is Cloudflare's address.
  - New rule: use `CF-Connecting-IP` **only when** the CloudFront viewer address lies in Cloudflare's published ranges (a committed constant with a refresh test). Otherwise use the viewer address.
  - This also fixes the forgot-password limiter, and it cannot be spoofed by calling CloudFront directly.
- **Email quota.** Sending moves from Cognito's default (about 50 a day) to SES on `harrisonfamily.us`. The global caps above keep the site from becoming a mail cannon.

### 7.6 Allowlist in DynamoDB (composite resolver)
- **Items:** `ALLOW#<normalized email>` / `META` = `{sub, state:"active"|"revoked", source:"access-request"|"admin"|"import", requestId?, at, by}`, with `GSI1PK=ALLOWSUB#<sub>`, `GSI1SK=ALLOW#<email>`.
- **Resolver.** `auth/src/allowlist.js` is a host `PrincipalResolver` passed to `createIdentityService` and `cognitoProvisioner` in place of `buildResolver(m.resolver, …)` (`auth/src/index.js:45, 60, 102`):
  1. GetItem `ALLOW#<email>`:
     - `active` → `{sub, label: email, roles: ["member"]}`;
     - `revoked` → `null`, **even if the S3 file lists the email**.
  2. Otherwise the cached S3 file, as today. On S3 failure the last good copy is served (kit behaviour).
  3. On a DynamoDB error with an S3 hit, the S3 result is used. On a DynamoDB error with an S3 miss, it fails closed (null).
- **Membership** (`auth/src/membership.js`, the MCP groups) adds DDB members through `Query GSI1PK=ALLOWSUB#<sub>`.
- **Why DynamoDB and not IAM on `config/userGrampsID.json`:**
  - io's publisher overwrites that object from local files, so Lambda grants would vanish.
  - A JSON-file read-modify-write races.
  - Per-entry items carry state, audit and revocation.
  - The manifest's resolver stays `s3_allowlist`, because `validateManifest` knows only that kind and `static`. No kit change is needed.
- **Legacy path.** `hfy-check-allowed` does not see DynamoDB grants. It retires after the authV2 release (HFY-R4), and `authV2` is on.
- **Docs.** `manage-family-access.md` gains "Approve a request" and "Remove access granted through a request". An optional `scripts/infra/import-allowlist.mjs` (dry-run by default) copies S3 entries into `ALLOW#` with `source:"import"`, if io wants DynamoDB as the single source later.

### 7.7 First password for approved members without Google (SURF-D18)
- **Today:**
  - The first sign-in must be Google, because Cognito users exist only after `/auth/link` (`identity-model.md:57`).
  - Forgot-password for a non-existent user silently sends nothing (`docs/how-to/diagnose-sign-in-and-api-failures.md:321`).
- **Proposal:**
  - In the edge's `/auth/password/forgot` handling, after the existing rate limit (`edge.js:336-339`) and before the kit call, check the allowlist (DDB or S3).
  - If the email is allowlisted and `AdminGetUser` says the user does not exist, run `AdminCreateUser` with `MessageAction: SUPPRESS` and `email_verified=true`, then `AdminSetUserPassword` with a random 32-byte permanent password.
  - Then the kit's forgot flow sends Cognito's **code** to the mailbox.
- **Why it is safe:**
  - The account is useless without the mailbox, so the pre-registration attack in `identity-model.md:57` stays closed.
  - The code is not a sign-in link.
  - The edge role already holds these Cognito actions (`app-stack.yaml:270-273`).
- **It supersedes** the "only at /auth/link" sentence of HFY-R58 ruling 5 and `identity-model.md:57`, so io decides.
- **Without it,** approved requesters must use a Google account for that email, and the approval email says so.

### 7.8 Email channel (SES)
- **Prerequisites (io gate, SURF-D11):**
  - an SES domain identity `harrisonfamily.us` in us-west-2 with Easy DKIM (3 CNAMEs in Cloudflare DNS);
  - a DMARC TXT;
  - SES production access;
  - a From address and display name;
  - `SesIdentityArn` set on the app stack, which also lifts Cognito's 50 a day (`app-stack.yaml:31`).
- **Sending:**
  - A configuration set with no open or click tracking.
  - Plain text only.
  - New IAM: `ses:SendEmail` on the identity ARN, with an `ses:FromAddress` condition, for the edge and api roles.
  - `auth/src/mailer.js` and `api/src/mailer.js` are thin senders over `shared/emails.mjs` templates.
- **Templates** (lowercase except "Harrison" and site names; footer `harrisonfamily.us · kept by the family, for the family`; no links):

| id | subject | body |
|---|---|---|
| `code` | your Harrison Family code | `your code is {code}. it works for 15 minutes.` / `if you didn't ask to join the Harrison family site, ignore this. nobody can join with your address without this code.` |
| `already_member` | you're already on the list | `you're already on the list. open harrisonfamily.us and tap sign in with this email.` |
| `already_requested` | we have your request | `we already have your request. we'll email you when it's done.` |
| `received` | we got your request | `we got your request to join. someone in the family will look at it soon, usually within a few days. we'll email you either way.` |
| `approved` | you're in | `you're in. open harrisonfamily.us and tap sign in.` / `- if this is a gmail address, tap continue with google.` / `- otherwise tap forgot password? and we'll email you a code to set one.` / `we will never email you a link to sign in.` |
| `awaiting_record` | you're approved | `you're approved. we're adding you to the family tree now. we'll email you again when you can sign in.` |
| `declined` | about your request | `we couldn't add you to the family site.` + optional `a note from the family: {note}` + `if you think that's a mistake, ask the family member who told you about the site to reach out.` |
| `admin_new` | someone asked to join the family site | `someone asked to join the family site. open the family site, then settings → family requests.` |

### 7.9 Retention (SURF-D15, privacy-defining; it needs a row in `docs/drafts/privacy-terms-2026-10-update.md` §3.3 and §4)

| data | kept | how |
|---|---|---|
| code (`ACCESSCODE#`) | 15 min | TTL |
| ticket (`ACCESSTICKET#`) | 60 min or first use | TTL, conditional delete |
| pending request (email, form) | 90 days without a decision | TTL deletes it; the AUDIT stub keeps `{id, state}` only |
| decided request (active, declined, awaiting) | 30 days after the decision, for re-sends and corrections | `ttl = decidedAt + 30 d`. An `awaiting_record` request keeps its TTL refreshed until linked or declined. |
| duplicate guard (`ACCESSREQEMAIL#<emailHash>`) | as long as the request; 30 days after a decline | TTL |
| email as the sign-in key (`ALLOW#`) | while access lasts | deleted when io removes access for good, or by the revoke flow |
| Gramps-mapped facts | normal family-tree retention | they move through a proposal, never the email |
| logs | never contain email, code, ticket or form values | redaction test |

`emailHash` = `HMAC-SHA256(pepper, email)`; the pepper is a new secret, `harrisonfamily/access-request/pepper`.

### 7.10 UX
**`/join/`.**
- A repo-owned public page: `11ty/join/index.html` plus island `join`, registered as in §3.1.
- Without the flag or with `open:false`, it shows: `asking to join isn't open yet. if you're family, ask the person who told you about the site to reach out.`

**Steps:**
- **Intro.**
  - h1 `ask to join the family site`.
  - Lede: `this site is just for family. tell us who you are and we'll add you. it takes about 5 minutes.`
  - Privacy line: `we only use your email so you can sign in. we never show it to anyone.`
  - `first, we'll email you a 6-digit code.`
- **Step 1.**
  - Email (16px; hint `a gmail address lets you sign in with google`).
  - Turnstile.
  - Button `email me a code`.
- **Step 2.**
  - `we sent a 6-digit code to {email}. it works for 15 minutes.`
  - Input `autocomplete="one-time-code" inputmode="numeric"`, then `check it`.
  - `didn't get it? check spam, or send another` (enabled after 60 s).
  - `use a different email`.
- **Step 3.**
  - Two fieldsets with legends: `about you` (S1) and `your timeline` (S2).
  - Radios in fieldsets, the `forSelf` checkbox, and `send my request`.
- **Done.**
  - `got it. we'll look at it and email you, usually within a few days.`
  - `while you wait, the family's story is on the about page.` → `/about/`.

**Behaviour.**
- A step indicator reads `step 2 of 3`.
- Focus moves to each step's heading.
- An error summary (`role=alert`) links to the fields. Each field error uses `aria-describedby`.
- The draft is kept in `sessionStorage["hfy:join-draft"]` (the form only, never the code or ticket) and cleared on success.
- An expired ticket returns to step 1 with `that took a while, so we need to check your email again. your answers are saved.`

**Entry points (`accessRequests`):**
- The edge denied banner (`allowlistNotice` and `deniedNotice`, `edge.js:89-126`) gains an "ask to join" link to `/join/` when `ACCESS_REQUESTS=on`.
- The signed-out homepage hero and /about/ show a quiet line, `new here? ask to join.` It is rendered by the loader, not by editing Eleventy output.
- `/contact/` gets the same line.
- No email ever travels in a URL.

**Errors (voice):**
- `that's a lot of codes. wait an hour, then try again.`
- `that code didn't work. check your email for the newest one.`
- `that looks like a phone number. take it out, then send.`
- `just the city and state is plenty.` (an address-shaped place)
- `just the year, like 1962.`
- `we're getting a lot of requests right now. try again tomorrow.`
- `asking to join is closed for now.`
- `that didn't work. try again in a minute.` (`503`)

**`/me/requests/` (admins).**
- **Page and island.** A repo-owned page with island `access-requests`. A non-admin sees `this page is for the people who look after the site.`
- **Tabs:**
  - `waiting`: `pending`, the default.
  - `adding to the tree`: `awaiting_record`.
  - `done`.
- **List cards:** `{givenNames} {maidenSurname}` (as entered, proper case), `born {year} · {birthPlace}`, and the relative time `asked 3 days ago`.
- **Detail:**
  - The answers in a label/value list.
  - The email, with a `copy` button.
- **`who is this?`:**
  - The top 5 candidates, scored client-side over `/person/index.json` by maiden surname, given-name token overlap, birth year within ±2, and birthplace.
  - Each shows the display name and lifespan, with a button `it's them`.
  - Also `they're new` (the editable Gramps preview) and `not now / decline` (with an optional note and the `include this note in the email` checkbox).
- **Confirms:**
  - `give {name} access as {person}?` → `let them in` · `not yet`.
  - `remove {name}'s access?` → `remove` · `keep`.
- **Results:** `done. we emailed them.` or `done, but the email didn't send. let them know yourself.` (`emailSent:false`).
- **375 px:** list then detail as separate views (`?id=`). Actions stack at the end, one control height per row, 44px.
- **Desktop:** two columns, answers on the left and matching and actions on the right.

---

## 8. Photo tag UI (R-29, R-30)

### 8.1 Data contract (produced by the R-31 / D-02 data domain; consumed here)
Each `person.mediaGallery[]` item gains:
```json
"tags": [{ "grampsId": "I....", "name": "...", "rect": [x1, y1, x2, y2] | null, "isPrimary": true,
           "attributes": [{ "type": "Age", "value": "12" }], "source": "gramps" | "site" }]
```
- `rect`: Gramps integer percent, copied exactly.
- `isPrimary`: this ref is index 0 of that person's `media_list`, their portrait.
- `attributes`: the MediaRef attributes, after R-18 scanning.
- `source`: `site` marks R-31 web tags.
- **Tags across people.** A tag lists everyone tagged in the photo, through the media's back-references. A group photo then shows every tagged person in every tagged person's gallery.
- **Rects:**
  - Corners are normalised (min and max) and clamped to 0..100 on the client.
  - A null rect means the person is tagged without an area marked.
- **Orientation.** Images are orientation-normalised before tagging, the data domain's rule. Today none of the 16 readable record files is rotated.

**Gramps has no tag "role".** The tag data shown is:
- **name;**
- **role** = the tagged person's relationship to the page's person, computed client-side from `person.familyTree` with the DS tree vocabulary (`this person`, `parent`, `grandparent`, `sibling`, `spouse`, `child`, `grandchild`, else `family`);
- **portrait** when `isPrimary` is set;
- **area** = the rect in words and numbers: `upper left · 12% from the left, 8% from the top, 20% wide, 25% tall`;
- **attributes**;
- **source:** `tagged in the family tree` or `tagged on the site`.

### 8.2 Rendering
- **The seam.**
  - `person-page.js` dispatches `hfy:person-rendered` `{detail: {person}}` at the end of `renderPerson` (`:264-288`).
  - It also dispatches `hfy:lightbox-media` `{detail: {index, media, img}}` after the lightbox image loads (`:1438-1500`, the `loader.onload` branch).
  - The island `photo-tags` (flag `photoTags`) listens. No markup ownership moves.
- **Geometry** (`islands/src/lib/photo-tags.js`, pure):
  - `containedRect(boxW, boxH, natW, natH, fit)`: for `object-fit: contain`, `s = min(boxW/natW, boxH/natH)`, `w = natW·s`, `h = natH·s`, `x = (boxW−w)/2`, `y = (boxH−h)/2`.
  - `regionBox(rect, contained)` → px.
  - A `ResizeObserver` on each image re-places the layer.
- **Thumbnail** (inside `button.media-lightbox-trigger`, so decorative only):
  - `span.photo-tags__layer[aria-hidden=true]` holds one `span.photo-tags__region[data-role]` per rect. Each region carries a name label that shows on `:hover`.
  - When the button has keyboard focus, every label shows, so keyboard users see the names before opening.
  - A click anywhere still opens the lightbox (unchanged).
- **Names list** under `figcaption.gallery-caption` (`person-page.js:586-589`):
  - `ul.photo-tags__names[aria-label="in this photo"]`. The image gains `aria-describedby` → the list.
  - Each `li` holds a `button.photo-tags__name[aria-expanded][aria-controls]`.
  - **Hover (`(hover: hover)`) or focus:** the matching region gets `.is-active` (outline plus label), and a hovercard (`role="tooltip"`, referenced by `aria-describedby`) shows the tag data (§8.1). The hovercard is plain text, can itself be hovered, and Esc dismisses it (WCAG 1.4.13).
  - **Click, tap or Enter:** toggles a pinned inline panel with the same data plus `open {name}'s page` → `/person/?id=`. The region stays highlighted while the panel is open.
  - **Touch** (no hover): the first tap is the toggle. Hover-only information therefore never exists.
- **Lightbox:**
  - The regions are interactive: each `a.photo-tags__region` links to the person's page with `aria-label="{name}, {role}. open their page"`. The links are in DOM order (top-to-bottom, then left-to-right) and carry the DS focus ring.
  - A header toggle `names` (`aria-pressed`, 44px), next to download, shows or hides labels. It defaults on for `(pointer: coarse)` and off for fine pointers, where hover shows them.
  - The same names list renders under `#mediaLightboxCaption`.
  - Navigating to the next or previous photo re-renders on `hfy:lightbox-media`.
- **Overlaps and density:**
  - Labels sit under their region, flip above near the bottom edge, and are clamped inside the image.
  - Colliding labels are stacked by a greedy vertical offset.
  - Above 12 tags, labels show only for the active region.
- **Styling** (`islands/src/photo-tags.css`, tokens only, under theme-lint):
  - A region is a 2px ring in the role's `--io-color-semantic-tree-<role>` with an ink halo, readable on any photo.
  - Labels are `size-sm` chips on `surface.raised`.
  - No transitions under `prefers-reduced-motion`.
  - In `forced-colors` mode, the region outline is `CanvasText`. If theme-lint rejects the system-colour keyword, a lint exemption is needed.
- **Missing images.**
  - A placeholder or missing image (`gallery-photo--missing`, `person-page.js:582`) gets no layer, but the names list still renders.
  - A tag whose rect is null shows `no area marked` in its data.
- **Privacy.** Tags are visible to every signed-in member, like the rest of the gated data (SURF-D20). Untagging oneself belongs to R-31's editor.

### 8.3 UX
- **375 px:**
  - One gallery column (`col-12`). The names list wraps as 44px chips under the photo, and the pinned panel opens full width under the list.
  - In the lightbox, labels are on by default and each label is the tap target, at least 44px through padding.
- **Desktop:**
  - Three gallery columns. Hovering a name highlights the region on the thumbnail above.
  - In the lightbox, hovering a region shows its label and Tab walks the regions.

---

## 9. Data model (exact keys added by this domain, table `hfy-app`)

| PK | SK | attributes | GSI1PK / GSI1SK | TTL | writer |
|---|---|---|---|---|---|
| `OTD#INDEX` | `V1` (`V1#MM` if sharded) | `schema, sourceVersion, policyVersion, generatedAt, body (B, gzip JSON), size, buildingUntil?` | — | — | hfy-api |
| `OTD#HIDDEN` | `META` | `ids: [itemId], version` | — | — | hfy-api |
| `PLINKS#<gramps_id>` | `META` | `links {platform: {url, handle?\|host?}}, version, updatedAt, updatedBy` | — | — | hfy-api |
| `ACCESSREQ#<ulid>` | `META` | `id, state, version, createdAt, updatedAt, email, emailHash, form{…}, decision?{kind, by, at, grampsId?, note?}, proposalId?` | `ACCESSREQS#<state>` / `<ulid>` | pending +90 d; decided +30 d | edge (create), hfy-api (decide) |
| `ACCESSREQEMAIL#<emailHash>` | `META` | `requestId, state` | — | same as the request | edge, hfy-api |
| `ACCESSCODE#<emailHash>` | `META` | `codeMac, attempts, expiresAt` | — | +15 min | edge |
| `ACCESSTICKET#<sha256(ticket)>` | `META` | `email, emailHash, expiresAt` | — | +60 min | edge |
| `ALLOW#<normalized email>` | `META` | `sub, state(active\|revoked), source, requestId?, at, by` | `ALLOWSUB#<sub>` / `ALLOW#<email>` | — | hfy-api (decide, revoke), import script |
| `RATE#<name>:<scope>#<hash>` | `W#<window>#<start>` | `n` | — | window end +300 s | edge (existing scheme, new names `joincode`, `joinverify`, `joinsubmit`) |
| `AUDIT#plinks:<gramps_id>` / `AUDIT#accessreq:<ulid>` / `AUDIT#allow:<emailHash>` / `AUDIT#otd` | `<at>#<ulid>` | `op, id, principal, at, before, after` (no PII) | `AUDIT` / `<at>#<ulid>` | — | (existing `auditItem`, `api/src/txn.js:5-20`) |

- **Prefix collisions checked:**
  - `LINK#` (the auth link store), `PASSKEY#`, `REFRESH#`, `FAMILY#`, `MCP*` and `RATE#` belong to the edge.
  - `POST#`, `COMMENT#`, `THREAD#`, `AUTHOR#` and `SUBJECT#` belong to the api (`api/src/keys.js`).
  - The GSI1 values `SUB#` (edge links) and `POSTS` already exist; `ALLOWSUB#` and `ACCESSREQS#` are new and distinct.
- **No new S3 objects.** No new CloudFront behaviour.
- **Secrets:** `harrisonfamily/auth-edge/turnstile` and `harrisonfamily/access-request/pepper`.
- **Stack parameters:** `AccessRequests` (off), `SesFromAddress`, `SesConfigurationSet`, and `TurnstileSiteKey` (public).
- **IAM additions:**
  - both roles: `ses:SendEmail` (identity ARN, From condition);
  - the api role: `dynamodb:ConditionCheckItem`;
  - the edge role: `secretsmanager:GetSecretValue` on the two new secrets.

---

## 10. API catalog (all new routes)

| surface | route | auth | name (caps) |
|---|---|---|---|
| api | `GET /api/me` | session | `me.get` |
| api | `GET /api/onthisday` | session | `onthisday.get` |
| api | `POST /api/onthisday/hide` | session (owner of a person in the item, or admin) | `onthisday.hide` |
| api | `DELETE /api/onthisday/hide/:itemId` | admin | `onthisday.unhide` |
| api | `GET /api/people/:id/links` | session | `links.get` |
| api | `PUT /api/people/:id/links` | owner, or admin (clear only) | `links.put` |
| api | `GET /api/access-requests` | admin | `accessRequests.list` |
| api | `GET /api/access-requests/:id` | admin | `accessRequests.get` |
| api | `POST /api/access-requests/:id/decision` | admin | `accessRequests.decide` |
| api | `POST /api/access-requests/:id/revoke` | admin | `accessRequests.revoke` |
| edge | `GET /auth/access-request/config` | anonymous | — |
| edge | `POST /auth/access-request/start` | anonymous, Turnstile | — |
| edge | `POST /auth/access-request/verify` | anonymous | — |
| edge | `POST /auth/access-request` | anonymous plus ticket, Turnstile | — |

- **API routes:**
  - They are added to `ROUTES` (`api/src/routes.js:61-129`). They inherit the 415 JSON rule, `no-store` and caps generation, and `scripts/gen-caps.mjs` regenerates `caps.json`.
  - None gets an `mcp` member, so no MCP tool and no `POLICY_ROWS` change. `parity/map.yaml` gains the new actions as HTTP-only.
- **Error envelope:** `{error, message, details?: {field?, fields?: [{field, code, suggest?}]}}`.
- **Edge error envelope:** the kit's `{code, detail}`.

---

## 11. Kit changes

**Required: none.** Everything is host-side:
- the allowlist resolver is a host `PrincipalResolver`;
- Turnstile and the rate limits wrap the edge;
- the gear is HFY markup, not a kit nav item;
- the overlays and validators are HFY code.

**Optional upstream backlog** (file on the kit backlog, not on this plan):
1. `@io-kit/auth`: a `dynamodb` allowlist resolver kind and a composite resolver, so other stacks get the same approval flow.
2. `@io-kit/auth`: provision an allowlisted member's first password through a forgot code (§7.7), as a kit option instead of an HFY wrapper.
3. `@io-kit/auth`: an edge "sign out on every device" for Cognito sessions (revoke all refresh families by sub). Today `everywhere` is Keycloak-only (`iokit packages/auth/src/edge/index.ts:452-481`).
4. `@io-kit/shell`: a `StackName` of `"harrisonfamily"` (`types.ts:8`), already a known follow-up (`shell.jsx:182-183`).

---

## 12. Flags

| flag | gates | loader route | server switch |
|---|---|---|---|
| `navMe` | the nav composition, the gear, the account-sheet "settings" row, the `settings` island | all pages (shell) and `/me/` | — |
| `onThisDay` | the `onthisday` island | `/` | — |
| `aboutCta` | the `about-cta` island | `/about/` | — |
| `profileLinks` | `person-links` and `links-editor`; the hub row | `/person/?id=`, `/me/links/` | — |
| `accessRequests` | `join`, `access-requests`, the entry lines, the hub row | `/join/`, `/me/requests/`, `/`, `/about/`, `/contact/` | edge `ACCESS_REQUESTS=on` (anonymous routes and the denied-page link) |
| `photoTags` | the `photo-tags` island | `/person/?id=` | — |

**Dependencies:**
- `accessRequests` requires `navMe`, because the queue is reached from the hub. The fallback rule is the HFY-R58 dependency fallback.
- `familyViz` (viz domain) composes with `navMe` as in §3.1.

---

## 13. Testing

- **Pure modules (node:test or vitest):**
  - `nav.js`: 4 flag combinations × signed in or out × current page.
  - `profile-links.mjs`: at least 150 table cases:
    - every platform's accepted and rejected hosts and paths;
    - the R-17 matrix (website rejects every platform host, including subdomains, short hosts, CDN and contact hosts);
    - look-alikes (`ig.com` accepted, `notfacebook.com` accepted, `facebook.com.evil.example` accepted as a website and shown as its host, `facebook.com@evil.example` rejected);
    - IDN display as ASCII;
    - phone-shaped paths rejected.
  - `legacy-form.mjs`:
    - required fields and the year regex with bounds;
    - the Unicode name charset;
    - address and phone rejection in place fields;
    - `mapToGramps` golden output, `_class` tagged, with birth year-only `dateval`.
  - `onthisday/build.js`:
    - fixtures from invented people;
    - a birth month or day in the input never reaches the output;
    - divorce excluded, private excluded, Bride and Groom roles joined.
  - `onthisday/select.js`:
    - tier precedence and deterministic rotation;
    - at most 1 remember item and 1 emoji;
    - distinct people.
  - `onthisday-copy.mjs`: every template lowercase except placeholders, no `!`, no `record`, plurals, no emoji in remember items.
  - `photo-tags.js`: `containedRect` across aspect ratios, rect normalisation, role computation.
- **API (vitest with the fake-ddb in `api/test/fake-ddb.js`):**
  - The routes' status matrix in §§4.4, 6.3 and 7.4.
  - Transaction atomicity: an allowlist conflict rolls back the state change.
  - Audit items without PII.
  - Retention TTLs set.
  - Lazy rebuild lease contention.
  - Past-year post queries by ULID range.
- **Edge (vitest):**
  - CSRF headers.
  - The kill switch.
  - Honeypot silence.
  - Turnstile failure modes (timeout → 503, wrong hostname or action → 403).
  - Each limiter, including the global caps and the queue cap.
  - Enumeration parity (start answers `202` for member, pending and new emails, with one SES call each).
  - Code attempt limits, ticket single use.
  - The composite resolver precedence matrix (DDB active, DDB revoked over S3 listed, S3 only, DDB error with S3 hit or miss).
  - `clientIp` with Cloudflare ranges against a spoofed `CF-Connecting-IP`.
  - First-password provisioning only for allowlisted, non-existent users.
  - Log redaction.
- **Playwright** (hermetic route stubs as in `islands/tests/shell.spec.mjs:11-25`), each at 375×812 and 1280×800:
  - `settings-hub.spec.mjs`, `onthisday.spec.mjs` (each tier from a stubbed API), `about-cta.spec.mjs`, `links.spec.mjs` (editor errors, the move-it suggestion, chips), `join.spec.mjs` (three steps, errors, draft restore, ticket expiry), `access-requests.spec.mjs` (list, detail, link, new, decline, revoke, 409 handling), `photo-tags.spec.mjs` (overlay alignment within 1 px of the computed box for contain and lightbox, hover cards, touch toggle with `hasTouch`, keyboard walk, Esc).
  - Every spec runs axe (zero serious or critical), checks 44px targets and 16px inputs, and checks that there is no horizontal scroll at 375.
- **Existing suites updated:** `family-route.test.mjs`, `family-route.spec.mjs`, `shell.spec.mjs`, `bundle.test.mjs` (the new islands), `person-page.spec.mjs` (section order unchanged; the links chips sit inside the hero), and `copy.test.mjs` (the /private/ title at the flip).

---

## 14. Rollout

1. **io gates first** (no code):
   - decisions SURF-D11, D13, D14, D15, D16 and D18;
   - SES identity, DKIM, DMARC and production access;
   - the Turnstile widget;
   - at least one approver in `config/admins.json`.
2. **Foundations:**
   - `shared/` packaging, `GET /api/me`, the DynamoDB allowlist resolver, and the Cloudflare-aware `clientIp`.
   - These deploy dark: the resolver with no `ALLOW#` items behaves exactly as today. That is verified by the precedence tests and a live sign-in.
3. **Surfaces land dark** behind flags, in any order:
   - nav and hub, then about CTA and links;
   - on this day after D-02 types (year tier) and the record-store adapter (all tiers);
   - photo tags after the tag export;
   - access requests after SES.
4. **D-11 audit per surface** on production with `?hfy_flags=` (HFY-R42):
   - screenshots under `s3://jreese-net/agent-documents/assets/<TASK>/` (HFY-R16);
   - an io iPhone pass for nav, the join flow and touch tags.
5. **Flips** (flags deploy first, HFY-R67 and HFY-R70; mirror Dropbox `flags.json`):
   - `navMe` together with or before `familyViz` (§3.1 composes either way);
   - `aboutCta`, `profileLinks`, `photoTags`, `onThisDay`;
   - last, `accessRequests` plus the edge `ACCESS_REQUESTS=on`, after an end-to-end request by io from a non-Gmail test inbox.
6. **Rollback:**
   - A flag off hides any surface.
   - `ACCESS_REQUESTS=off` stops anonymous intake at once.
   - Revoking `ALLOW#` items removes granted access within about 1 hour.

---

## 15. Error-handling catalog

| # | where | condition | response | user sees (voice) | log / alarm |
|---|---|---|---|---|---|
| E1 | nav | `/auth/session` pending or unreachable | "me" = `/private/` | the normal tab | — |
| E2 | nav | signed in, no sub | `familyUrl()` null; the person page shows its error | `that didn't work. try again, or text {steward}.` | warn |
| E3 | hub | `/api/me` fails | admin rows hidden; member rows render | — | warn |
| E4 | otd | index missing and build fails | 503 | section absent | error `onthisday build failed` |
| E5 | otd | build fails, stale index exists | 200 `stale:true` | normal | warn |
| E6 | otd | two concurrent rebuilds | the lease loser serves stale or waits 1 s and re-reads | normal | info |
| E7 | otd | the input carries a birth month or day | dropped, `report.droppedBirthPrecision++` | — | warn with count, never the value |
| E8 | otd | hide not allowed | 403 | `only family on that line can hide it.` | — |
| E9 | cta | index or own-record fetch fails | cards without counts, no nudge | — | — |
| E10 | links | invalid field | 422 `fields[]` | per-field copy (§6.4) | — |
| E11 | links | version conflict | 409 with the current item | `someone changed this a moment ago. here's the latest.` | — |
| E12 | links | non-owner write | 403 | `you can only change your own links.` | — |
| E13 | links | GET fails on a person page | chips omitted | — | warn |
| E14 | join | kill switch off | 503 `closed` | `asking to join is closed for now.` | — |
| E15 | join | honeypot filled | 202, no work | (nothing different) | info `honeypot` |
| E16 | join | Turnstile timeout or outage | 503 | `that didn't work. try again in a minute.` | error |
| E17 | join | Turnstile invalid | 403 `bot_check_failed` | `we couldn't check that. reload the page and try again.` | info |
| E18 | join | rate limited | 429 + `retry-after` | `that's a lot of codes. wait an hour, then try again.` | info |
| E19 | join | global cap or queue full | 429 / 503 `queue_full` | `we're getting a lot of requests right now. try again tomorrow.` | alarm (`queue_full`) |
| E20 | join | limiter write fails | 503 (fail closed, no email) | as E16 | error |
| E21 | join | SES send fails on the code | 503 | as E16 | error `ses` |
| E22 | join | wrong code / expired / too many | 400 / 410 / 429 | `that code didn't work. check your email for the newest one.` / `that code ran out. send another.` | — |
| E23 | join | ticket expired | 401 | `that took a while, so we need to check your email again. your answers are saved.` | — |
| E24 | join | validation or contact info | 400 `fields[]` | per-field copy (§7.10) | — |
| E25 | join | open request or already a member (after ticket) | 409 | `we already have your request. we'll email you.` / `you're already on the list. sign in.` | — |
| E26 | join | received-email or admin fan-out fails after commit | 201 still | normal | error (request stands) |
| E27 | admin | not admin | 403 | `this page is for the people who look after the site.` | — |
| E28 | admin | stale version or state | 409 | `someone already answered this one. here's where it stands.` | — |
| E29 | admin | email already active / person already has access | 409 `already_member` / `second_email` | `that email already has access.` / `{person} already signs in with another email. add this one too?` | — |
| E30 | admin | unknown gramps_id | 422 | `that page doesn't exist yet. publish it from the family tree first.` | — |
| E31 | admin | SES fails after a decision | 200 `emailSent:false` | `done, but the email didn't send. let them know yourself.` | error |
| E32 | admin | proposal service unavailable on "new" | 503, no state change | `that didn't work. try again, or text {steward}.` | error |
| E33 | resolver | DDB error, S3 hit / S3 miss | allow / deny (fail closed) | normal / the sign-in denied banner | error |
| E34 | forgot | the first-password provisioning call fails | 502 (kit `AUTH_NETWORK`) | the kit's reset error copy | error |
| E35 | tags | image dimensions unknown or the image failed | no layer; names list still renders | — | — |
| E36 | tags | the tagged person has no page (redacted) | not exported by the data domain; the client defensively drops tags without a `grampsId` | — | warn |

---

## 16. Decisions

| id | question | default | io? |
|---|---|---|---|
| SURF-D1 | What happens to the "family" tab when "me" takes the own page? | It leaves the bar while `navMe` is on and `familyViz` is off. With both on it is `/tree/`. It is never `/family/`, a gated prefix. Supersedes the HFY-R74 first clause. | no |
| SURF-D2 | Where does the gear live? | `.hfy-bar__end`, all widths, signed in only, `/me/`; the account sheet gains "settings". | no |
| SURF-D3 | What does `/private/` mean after R-20? | It stays the own-page redirect for "me". `/tree/` needs no redirect. The viz domain should not repoint `familyUrl()`. | no |
| SURF-D4 | The on-this-day source and fallbacks | The tier ladder of §4.1, built from the record store's projection, served from `OTD#INDEX` through the API with a lazy rebuild. | no |
| SURF-D5 | Living people's birth milestones | "turns {n} this year" only for `living` and n ≤ 100; otherwise neutral wording. Members and admins can hide items. | no |
| SURF-D6 | Links storage | DynamoDB, member-owned; no Gramps `Url` sync. | no |
| SURF-D7 | Short and share links | Rejected (no outbound resolution). | no |
| SURF-D8 | LinkedIn `/company/` | Rejected; personal profiles only. | no |
| SURF-D9 | Do links count as contact info? | Public social profiles are allowed. Email and phone are not. Contact-channel links are rejected everywhere. | no |
| SURF-D10 | Where does the anonymous intake live? | The auth edge, with an env kill switch. | no |
| SURF-D11 | The email channel for requesters and admins | SES domain identity `harrisonfamily.us` (DKIM in Cloudflare DNS), production access, plain text, no tracking. io picks the From address. | **yes** |
| SURF-D12 | When is the email verified? | First, by a 6-digit code, before the form. | no |
| SURF-D13 | Where does the allowlist of record live? | DynamoDB `ALLOW#` items through a composite resolver (DDB active or revoked beats the S3 file). io's file keeps working. | **yes** |
| SURF-D14 | Who approves access requests? | Admins in `config/admins.json` (empty today). io names them; the proposed initial set is io alone. | **yes** |
| SURF-D15 | Retention of request data | §7.9: pending 90 d, decided 30 d, email kept only in `ALLOW#` while access lasts. | **yes** |
| SURF-D16 | Store a living requester's current city? | Yes, at city and state level only, as a Residence event; street and ZIP rejected. | **yes** |
| SURF-D17 | New-person approvals | The cloud never mints a gramps_id. `awaiting_record` until linked (manually in v1, by the record store's hook later). | no |
| SURF-D18 | First password for approved members without Google | Provision a Cognito user with a random password at forgot-password for allowlisted emails; the mailbox code proves ownership. Supersedes the HFY-R58 and identity-model "only at /auth/link" sentence. | **yes** |
| SURF-D19 | Step-up for web approvals | None in v1: audited, reversible, every admin informed. | no |
| SURF-D20 | Who sees photo tags? | Every signed-in member, like the rest of the gated data. Untagging oneself is R-31's editor. | no |
| SURF-D21 | What is the tag "role"? | Relationship to the page's person, plus the portrait flag and the Gramps MediaRef attributes. Gramps has no role field. | no |
| SURF-D22 | Bot protection | Turnstile plus a honeypot plus layered rate limits and global caps, with a Cloudflare-aware `clientIp`. | no |
| SURF-D23 | Admin notification content | Inbox item plus an email with no requester details and no link. | no |

---

## 17. Risks

- **R-1** SES production access can be delayed or denied. It blocks the whole access-request flip; nothing else waits on it. DKIM needs io's Cloudflare DNS change.
- **R-2** Allowlist dual source:
  - io's publisher overwrites only the S3 file. A member granted in DynamoDB and later listed in the file resolves to the DynamoDB entry.
  - Revoking an S3-listed member still needs the file. `manage-family-access.md` must say so.
  - The legacy `hfy-check-allowed` path ignores DynamoDB grants.
- **R-3** The api role can now grant access by writing `ALLOW#`. That widens the compromise impact `identity-model.md:85-87` already accepts (the API can plant passkeys). Narrowing the roles' key conditions is a separate hardening item.
- **R-4** First-password provisioning changes an identity assumption io approved (HFY-R58). Until io decides, approved non-Google requesters cannot sign in.
- **R-5** On this day stays mostly year-tier until members add dates. The rotation and the prompt mitigate repetition. Full tiers need D-02 types and the record store's structured dates; until then the interim adapter gives year milestones only.
- **R-6** Featuring living members' ages or deaths on the homepage may upset someone. The tone rules, the per-person hide and admin moderation mitigate.
- **R-7** Per-IP limits are coarse behind Cloudflare. A Cloudflare IP-range list must be refreshed occasionally (test-pinned).
- **R-8** Photo overlays misalign on EXIF-rotated images or wrong rects. They depend on the data domain normalising orientation and exporting rects exactly.
- **R-9** Cross-domain duplication:
  - `GET /api/me` (moderation), `shared/` packaging and the contact guard (privacy);
  - the inbox builder (notifications);
  - the `person.create` and `person.update` system proposals and the `completeAccessRequest` hook (proposals and record store);
  - the shell nav and `/private/` semantics (viz).
  - The orchestrator should dedupe by key before dispatch.
- **R-10** Tests pin today's nav and person page (`family-route.test.mjs:51-65`, `shell.spec.mjs:8,49-59`). Every nav change must update them in the same PR.
- **R-11** New repo-owned pages (`/me/`, `/me/links/`, `/me/requests/`, `/join/`) are clobbered by an Eleventy refresh unless they are mirrored to the Dropbox source and excluded from rsync (HFY-R46).
- **R-12** Turnstile adds a Cloudflare-hosted script and a dashboard dependency outside the repo. If it is unavailable, intake fails closed.
- **R-13** Email typos are mitigated by verification, but the code step adds friction for older family members. Clear copy and the saved draft mitigate.
- **R-14** Anonymous request items share the table with session and passkey records, separated only by key prefix (`member-content-design.md:128-132`).

---

## 18. Tasks (one worker PR each)

| key | wave | repo | type | depends on | covers |
|---|---|---|---|---|---|
| `surf-io-decisions` | W0 | none | no_code | — | R-23 |
| `surf-ses-turnstile-ops` | W0 | none | no_code | `surf-io-decisions` | R-23 |
| `surf-shared-modules` | W1 | harrisonfamily | github_pr_deploy | — | R-17, R-42 |
| `surf-api-me` | W1 | harrisonfamily | github_pr_deploy | — | R-21, R-23 |
| `surf-allowlist-ddb` | W1 | harrisonfamily | github_pr_deploy | `surf-io-decisions` | R-23 |
| `surf-edge-clientip` | W1 | harrisonfamily | github_pr_deploy | — | R-23 |
| `surf-nav-me` | W2 | harrisonfamily | github_pr_deploy | `surf-api-me` | R-20, R-21 |
| `surf-settings-hub` | W2 | harrisonfamily | github_pr_deploy | `surf-nav-me` | R-21 |
| `surf-links-validator` | W2 | harrisonfamily | github_pr_deploy | `surf-shared-modules` | R-16, R-17 |
| `surf-legacy-form-schema` | W2 | harrisonfamily | github_pr_deploy | `surf-shared-modules` | R-23, R-42 |
| `surf-about-cta` | W2 | harrisonfamily | github_pr_deploy | — | R-15 |
| `surf-onthisday-core` | W2 | harrisonfamily | github_pr_deploy | `surf-shared-modules` | R-14 |
| `surf-links-api` | W3 | harrisonfamily | github_pr_deploy | `surf-links-validator` | R-16, R-17 |
| `surf-onthisday-api` | W3 | harrisonfamily | github_pr_deploy | `surf-onthisday-core` | R-14 |
| `surf-access-request-edge` | W3 | harrisonfamily | github_pr_deploy | `surf-legacy-form-schema`, `surf-allowlist-ddb`, `surf-edge-clientip` | R-23, R-42 |
| `surf-photo-tags-ui` | W3 | harrisonfamily | github_pr_deploy | — (external: tag export) | R-29, R-30 |
| `surf-links-ui` | W4 | harrisonfamily | github_pr_deploy | `surf-links-api`, `surf-settings-hub` | R-16, R-17 |
| `surf-onthisday-island` | W4 | harrisonfamily | github_pr_deploy | `surf-onthisday-api` | R-14 |
| `surf-join-page` | W4 | harrisonfamily | github_pr_deploy | `surf-access-request-edge` | R-23, R-42 |
| `surf-access-admin-api` | W4 | harrisonfamily | github_pr_deploy | `surf-access-request-edge`, `surf-api-me` | R-23 |
| `surf-access-admin-ui` | W5 | harrisonfamily | github_pr_deploy | `surf-access-admin-api`, `surf-settings-hub` | R-23 |
| `surf-first-password` | W5 | harrisonfamily | github_pr_deploy | `surf-allowlist-ddb`, `surf-io-decisions` | R-23 |
| `surf-d11-audit` | W5 | none | no_code | all surface tasks | all |
| `surf-flag-flips` | W6 | harrisonfamily | github_pr_deploy | `surf-d11-audit`, `surf-ses-turnstile-ops` | all |

The acceptance criteria are in the structured return.
