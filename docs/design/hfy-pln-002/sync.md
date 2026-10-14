# HFY-PLN-002 design: sync domain (Gramps <-> cloud, source of truth, redaction, rendering)

Covers: R-03, R-04, R-05, R-19, R-31 (data/sync side), D-01, D-02, D-03.
Inputs: requirements.md, pln002-intent.md (DOC-2CFAE07B546C), digest.md, understand.json, brd7cb.md (D-01..D-16, Q-1..Q-5), catalog/10-rulings.md (HFY-R1..R76).
Repos read: harrisonfamily `~/e0/wt/hfy-main-read` at c712e68; io-kit `~/e0/wt/iokit-main-read` at 31f6fb3; the out-of-repo ETL at `<project>/scripts/etl` (`<project>` = io's Dropbox project folder, not a git repo); Gramps.app 6.0.6 bundle sources.
Privacy: this document carries no person's name, date or contact detail. Counts and structure only. Example IDs (`I9001`, `I8000`) are fictional or reserved-block numbers.

---

## 1. Problem

Today the flow is one-way and hand-run: `<project>/scripts/etl/export_person_data.py` reads the Gramps SQLite DB read-only, writes per-entity JSON to `workspace-local/harrisonfamily-frontend`, and `sync_to_s3.py` runs `aws s3 sync --delete` per prefix (`sync_to_s3.py:26`, `:92`, `:126`). The S3 JSON is the only "database" the site has; hfy-api can read only `person/*.json` (`infrastructure/cloudformation/app-stack.yaml:102-105`) and only for author labels (`api/src/labels.js:12-13`).

io's north star (R-03, R-04, R-05): the cloud backend becomes the source of truth, Gramps <-> website both ways, io keeps editing in Gramps and pushes, and his desktop consumes cloud changes robustly with extensive error handling. R-19: DOBs never go to the cloud, and the sync explicitly refuses them. R-31 (data side): the store duplicates Gramps' photo-tag architecture so web tagging round-trips into Gramps.

Constraints found in discovery that shape everything below:

1. The cloud copy is a lossy projection of the local tree (no DOB, no contact info). A whole-object sync (Gramps Web Sync, plain upserts) would either push a DOB up or overwrite a local DOB with a year-only value. Merging must be field-level, with the local-only fields owned by the desktop.
2. Gramps 6.0.6 `change` is wall-clock seconds, goes backwards on undo, is preserved by XML import, and is not bumped on dependants. Deletes are hard with no tombstone (`gramps/plugins/db/dbapi/dbapi.py:803-813`). Undo is in-memory for one session (`gramps/gen/db/generic.py:146-155`). So we cannot use `change` as a sync clock; we need a stored base per object.
3. Writes must go through the Gramps API (derived columns, reference table, gender stats), never raw SQL, and never while another process holds the tree (`gramps/gen/db/utils.py:209-246` lock file; `gramps/cli/arghandler.py:566-576` CLI refusal).
4. `cli_tool` swallows exceptions and the process exit code does not report failure (`gramps/gui/plug/tool.py:301-325`), so headless runs need a status file.
5. gramps_id is a cross-system key (session `sub`, comment threads `THREAD#person:<id>`, URLs, S3 keys: `api/src/keys.js:7-9`, `api/src/comments.js:9`, `islands/src/lib/family-route.js:5`). IDs are per-database counters with a non-unique index; no reserved letter prefix survives Reorder Gramps IDs (digest gap-fill, `reorderids.py:609,672,739-767`).
6. The `aws s3 sync --delete` publish would silently overwrite or delete any cloud-made edit rendered into S3.
7. Export defects would corrupt a round trip (D-02): notes read Gramps 5 `_string/_tags` (`note_tags.py:152-158`), event types collapse to `{string:null, code:null}` (`transform.py:94-109`), media regions are dropped (`transform.py:324`), family type, child frel/mrel and family events are not exported (`transform.py:150-185`).

### 1.1 What already happened (state at 2026-10-13)

- D-01's immediate scrub is done: HFY-TSK-090 closed HFY-ISS-025 and HFY-R76 records it. The out-of-repo ETL now publishes the event year only (no `sortValue`; `date.text` blank when a day or month is present) (`transform.py:113-150`, patched 2026-10-13). A staged copy in `pln2/scrub/` shows 169 event files and 113 person files changed, all by removing `date.sortValue`; a post-apply download matched the staged output on a sample. Residuals are listed in section 12.
- HFY-R75: io's own session subject is the `hfy-admin` member in `config/groups.json` (not the subject the BRD named).

---

## 2. Decisions (summary; full rationale in the structured output)

| ID | Decision | Default | io? |
|---|---|---|---|
| SYNC-01 | Canonical store | Redacted Gramps-6 JSON per object, keyed by handle, versioned, in the existing `hfy-app` table; append-only change log doubles as version history and audit | no |
| SYNC-02 | Redaction policy v1 | Section 5: no birth day/month for anyone (birth-like events incl. baptism/christening/stillbirth/blessing), all Address objects and contact Urls local-only, Location street/locality/postal/phone local-only, street-level places local-only, Gramps `private` honoured (never in cloud), LDS ordinances and SSN/ID/AGE/TIME attributes local-only, photos with EXIF GPS held. Non-birth dates are stored at full precision but rendered year-only (HFY-R76) until the on-this-day domain changes it with io approval | **yes** |
| SYNC-03 | Gramps IDs for cloud-created objects | Default letter prefixes, reserved number block 8000-8999 per class (I8000, F8000, E8000, ...). Permanent at creation. No distinct letter prefix (it does not survive Reorder) | **yes** |
| SYNC-04 | Addon home and runtime | `harrisonfamily/gramps/`: `hfy_sync/` Gramps Tool addon (GUI + CLI) running in Gramps' bundled Python 3.13; `hfygramps/` pure-stdlib core shared with the cloud renderer | no |
| SYNC-05 | Desktop auth | OAuth 2.1 PKCE loopback public client `hfy-sync-desktop` on the existing HFY authorization server (`auth/src/oauth.js`), resource `https://harrisonfamily.us/api/sync`, refresh token in the macOS Keychain; authorization from a new `gramps-owner` group in `config/groups.json` | no |
| SYNC-06 | Rendering | Python Lambda `hfy-sync-render` triggered by the table stream (filtered to the change log), full deterministic render from the store, writes only changed keys; modes off/shadow/live | no |
| SYNC-07 | Legacy publish retirement | After the first live render, a bucket-policy deny on Put/Delete for the data prefixes except the renderer, the API (media binaries only) and a break-glass role; the Dropbox scripts get a refusal guard | no |
| SYNC-08 | Conflicts | No automatic winner for true conflicts. GUI resolves per field; CLI parks. Cloud keeps a redacted conflict record. A cloud change to a field that has a local-only refinement (birth year with a local day/month, a city with a local street place) is always a conflict | no |
| SYNC-09 | Destructive ops | Delete ops need step-up (amr `mfa` within 300 s, `api/src/policy.js:18-24`); mass-delete guards in both directions (> 10 objects or > 5 % in one run) | no |
| SYNC-10 | Renumber and merge | A synced person's gramps_id is immutable by default (renumbers blocked, local restore offered). Person merges are allowed from the GUI with step-up and leave an ID alias and a `mergedInto` stub | no |
| SYNC-11 | Media | Blobs keep today's keys `media/<handle><ext>`, uploaded by presigned PUT with a signed SHA-256; `Media.path` is local-only; cloud-created media download to `~/Pictures/hfy-sync-media/` (outside Dropbox) | no |
| SYNC-12 | Phasing | ARCH-C first (full snapshot every sync + op-batch push), then ARCH-B (change feed + gramplet). ARCH-A (Gramps Web API facade) and ARCH-D (live DB backend) rejected | no |
| SYNC-13 | D-01 residual | Permanently delete pre-scrub noncurrent S3 object versions of `person/`, `event/` keys if bucket versioning is on | **yes** |
| SYNC-14 | D-03 residual | Protect with ignore rules and a CI/pre-commit guard; do not delete io's Dropbox copies; recommend (not perform) moving real-data workspace folders out of Dropbox | **yes** |
| SYNC-15 | `isLiving` in the renderer | Keep today's rule (`death_ref_index == -1`, `transform.py:389`) for parity; changing it belongs to the privacy/living domain | no |

Proposed rulings for the catalog (the orchestrator assigns numbers):
- **R-SYNC-a** (amends BRD D-10): from cutover the family-data source of truth is the cloud store (`REC#`, `SYNC#LOG`); S3 `person/ family/ event/ note/ place/ media/*.json` is a rendered projection written only by `hfy-sync-render`; the JSON contract is preserved additively (new fields only; `sourcePath` dropped).
- **R-SYNC-b** (applies BRD D-15 to genealogy): every store write carries the principal, a CHANGE item (base version -> new version, full redacted object) and one `AUDIT#` item per batch.
- **R-SYNC-c**: the desktop sync is the `hfy_sync` addon in `harrisonfamily/gramps/`; handle is the sync key; the desktop owns local-only fields; deletes need step-up; cloud-minted IDs come from the 8000-8999 block.

---

## 3. Architecture

```
 io's Mac                                         AWS (us-west-2, behind CloudFront + Cloudflare)
 ┌──────────────────────────────────────┐        ┌───────────────────────────────────────────────────────────┐
 │ Gramps 6.0.6 (GUI or `-a tool` CLI)  │        │ hfy-api (Node 22, Function URL, /api/*)                     │
 │  └ hfy_sync addon                    │ HTTPS  │  ├ /api/sync/*  bearer (aud .../api/sync, gramps-owner)     │
 │     ├ projection P (redaction v1)    │◄──────►│  │   validator: schema + privacy + integrity + ID rules     │
 │     ├ 3-way field merge + lift       │ bearer │  │   applyBatch(): one TransactWriteItems per batch         │
 │     ├ preview / backup / DbTxn       │        │  ├ /api/records/* (member cookie, read-only)                │
 │     └ sidecar state.sqlite, status   │        │  └ applyBatch() also used by proposals/tagging domains      │
 │ Keychain: refresh token              │        │                                                             │
 │ ~/Pictures/hfy-sync-media (pulled)   │  PUT/  │ DynamoDB hfy-app: REC#…/HEAD, SYNC#LOG/<seq>, SYNC#HEAD, …  │
 └──────────────────────────────────────┘  GET   │   stream (KEYS_ONLY, filter PK = SYNC#LOG)                  │
             │ presigned                  ◄──────┤        ▼                                                    │
             ▼                                   │ hfy-sync-render (Python 3.13, reserved concurrency 1)       │
 s3://harrisonfamily-frontend/media/<handle><ext> │   full render from store -> diff -> write changed keys     │
 s3://harrisonfamily-sync/snapshots/<seq>.jsonl.gz│   shadow: s3://harrisonfamily-sync/render-shadow/…          │
                                                  │   live:   s3://harrisonfamily-frontend/{person,family,…}/   │
                                                  │   emits SYNC#RENDERED/<seq> (changed people) for notify     │
                                                  └───────────────────────────────────────────────────────────┘
```

Why this shape:
- The store lives in the table the API already owns (Q-3: per-stack infra; `app-stack.yaml:39-62` has PITR and SSE on). 536 objects (231 person, 57 family, 169 event, 37 place, 32 media, 6 note, 2 source, 2 citation) are a few MB including history.
- The change log is written in the same transaction as the head, so the log is the transactional outbox; the renderer and any later consumer (notifications R-11/R-12, contributions R-25..R-27) read it. DynamoDB Streams are only a trigger (24 h retention, digest map 5), never the cursor.
- The renderer reuses the ETL transforms, which already operate on Gramps JSON dicts (the same shape as the store), so the D-02 fixes land once, in Python, and run identically in tests, in shadow and live.
- The desktop never sends unredacted data. The server re-checks every op (defence in depth), and the renderer re-checks every output file (third line).

Rejected: ARCH-A (Gramps Web API facade + unmodified Gramps Web Sync): `merge()` keeps remote scalars and would overwrite local DOBs, `force=1` disables conflict checks, wall-clock classification, GUI only. ARCH-D (GrampsWebApiDb-style live backend): beta prior art with documented blind spots and it would need a local overlay for local-only fields anyway.

---

## 4. Data model

### 4.1 DynamoDB (`hfy-app`, PK/SK + GSI1; no new index)

Class names are Gramps `_class` values: `Person, Family, Event, Place, Source, Citation, Repository, Media, Note, Tag`.

| Item | PK | SK | GSI1PK / GSI1SK | Attributes |
|---|---|---|---|---|
| Record head | `REC#<Class>#<handle>` | `HEAD` | `RECS#<Class>` / `<gramps_id>#<handle>` (Tag: `#<handle>`) | `entity:"rec"`, `class`, `handle`, `gramps_id`, `version` (int, 1..), `seq` (global seq of last change), `deleted` (bool; tombstones are kept), `schema:21`, `redaction:1`, `obj_json` (canonical redacted Gramps JSON string, no `change` key), `hash` (sha256 hex of `obj_json`), `blob` (Media only: `{s3_key, sha256, md5, size, content_type, state: present\|missing}`), `updated_at`, `updated_by` (principal), `origin` (`desktop\|web\|proposal\|seed`) |
| Change log entry (= version history) | `SYNC#LOG` | `<seq, 12-digit zero-padded>` | `RECHIST#<Class>#<handle>` / `<version, 8-digit>` | `entity:"change"`, `seq`, `batch_id`, `op` (`create\|update\|delete\|withdraw\|marker`), `class`, `handle`, `gramps_id`, `version`, `base_version`, `obj_json` (null for delete/withdraw/marker), `hash`, `principal`, `origin`, `on_behalf_of` (proposals), `at` |
| Sequence head and config | `SYNC#HEAD` | `META` | — | `seq` (last committed), `tree_id` (uuid), `writes_enabled` (kill switch), `accepted_schema:[21]`, `redaction_version:1`, `min_client`, `bound:{dbid, fingerprint, bound_at, by}`, `id_next:{Person:8000, Family:8000, …}`, `id_max:8999`, `open_session` (id or null) |
| Batch receipt + idempotency | `SYNC#BATCH#<batch_id>` | `META` | `SYNCBATCH` / `<at>#<batch_id>` | `batch_id = base32(sha256(principal + ":" + Idempotency-Key))[0:26]`, `request_hash`, `principal`, `client`, `seq_from`, `seq_to`, `results:[{op_id, class, handle, version, seq, gramps_id}]`, `at` (kept forever; tiny) |
| Push session | `SYNC#SESSION#<session_id>` | `META` | — | `expected:[“<Class>#<handle>”]`, `state` (`open\|complete\|expired`), `opened_at`, `ttl` (+7 d) |
| gramps_id uniqueness guard | `GID#<Class>#<gramps_id>` | `META` | — | `handle` (conditional put/delete in the same transaction as the head) |
| ID alias (merge/renumber) | `IDALIAS#<Class>#<old_gramps_id>` | `META` | — | `handle`, `current_gramps_id`, `reason` (`merge\|renumber`), `batch_id`, `at` |
| Conflict queue | `SYNC#CONFLICT#<ulid>` | `META` | `SYNCCONFLICT#<state>` / `<opened_at>#<ulid>` | `class`, `handle`, `gramps_id`, `kind` (`field\|composite\|list\|delete_edit\|identity\|integrity`), `paths:[{path, base, cloud, desktop}]` (projected values only), `source` (`desktop_parked\|proposal_stale`), `state` (`open\|resolved\|dismissed`), `decision` (`keep_cloud\|keep_desktop\|manual`), `opened_at`, `resolved_at`, `by` |
| Desktop client heartbeat | `SYNC#CLIENT#<client_instance_id>` | `META` | — | `dbid`, `fingerprint`, `addon_version`, `gramps_version`, `schema`, `last_run:{run_id, action, result, exit_code, counts, finished_at}` |
| Render state | `SYNC#RENDER` | `STATE` | — | `rendered_seq`, `mode`, `renderer_version`, `last_error`, `last_full_at` |
| Render outbox (for notify/contributions) | `SYNC#RENDERED` | `<seq, 12-digit>` | — | `seq_from`, `seq_to`, `changed_people:[gramps_id]`, `deleted_people:[gramps_id]`, `principals:[…]`, `origins:[…]`, `at`, `ttl` (+400 d) |
| Pending blob upload | `SYNC#UPLOAD#<handle>` | `<sha256 hex>` | — | `s3_key`, `content_type`, `size`, `md5`, `ttl` (+1 h) |
| Audit (existing shape) | `AUDIT#<batch_id>` | `<at>#<uid>` | `AUDIT` / same | via `auditItem()` (`api/src/txn.js:5-20`): `op:"records.batch"`, `principal`, `before:[{class, handle, version}]`, `after:[{class, handle, version}]` |

Transaction budget per batch (TransactWriteItems max 100 actions, 4 MB): fixed 3 (`SYNC#HEAD` update with `seq = :old` condition, `SYNC#BATCH` put with `attribute_not_exists(PK)`, `AUDIT#` put) + per op 2 to 4 (head put with version condition, log put, GID put/delete, alias put). **Max 24 ops per batch**, and `2 × Σ obj_json bytes ≤ 3.5 MB`; the client splits by both. `ClientRequestToken` = `batch_id` (26 chars; 10-minute DynamoDB idempotency on top of the receipt item).

Head conditions: create `attribute_not_exists(PK) OR (deleted = :true AND version = :base)` (resurrecting a tombstone); update/delete `version = :base AND deleted = :false`.

Canonical JSON: `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` in Python; a recursive key-sorted `JSON.stringify` in JS; shared vectors prove byte equality (integers only; Gramps lat/long are strings). `hash` excludes nothing inside `obj_json`; `change` is never in `obj_json`.

### 4.2 S3

| Location | Writer | Content |
|---|---|---|
| `s3://harrisonfamily-sync/` (new, stack-managed, private, Block Public Access, SSE-S3, versioned) | | |
| `snapshots/<seq>.jsonl.gz`, `snapshots/latest.json` | hfy-api (on demand; role gains Get/Put on `snapshots/*`) | line 1 header `{"type":"header","tree_id","seq","schema":21,"redaction":1,"count","body_sha256"}`, then one `{"class","handle","version","seq","deleted","obj"}` per head; also the cold-start checkpoint for the store views (7.4); lifecycle: expire after 30 d (rebuilt on demand; with none left, a cold start folds the whole log) |
| `render-shadow/<site key>` | renderer (shadow mode) | exactly what live mode would write |
| `render/manifest.json`, `render/reports/<seq>.json` | renderer | `{key: sha256}` of renderer-owned keys; diff reports with keys and counts only |
| `s3://harrisonfamily-frontend/` (existing, not stack-managed) | | |
| `person/<gramps_id>.json`, `person/index.json`, `person/search-index.json`, `family/<handle>.json`, `event/<handle>.json`, `note/<handle>.json`, `place/<handle>.json`, `place/index.json`, `media/<handle>.json`, `media/index.json` | renderer (live mode) | the existing contract plus the D-02 fields (section 11) |
| `media/<handle><ext>` binaries | desktop via presigned PUT (API-signed) | unchanged key convention (`transform.py:343`) |
| `media/tree_<gramps_id>.svg` | unchanged (legacy) | not renderer-owned (section 11.5) |

No new site prefix is introduced, so the four lists that must agree (`sync_to_s3.py:26`, `scripts/infra/add-data-gate-behaviors.sh:46`, `scripts/cloudfront/append-index.js:20`, `ci.manifest.yaml:21-29`) stay as they are. The `person/index.html` shell is never touched by the renderer (it only manages `*.json` keys it wrote).

### 4.3 Desktop (io's Mac; never in Dropbox, never in git)

```
~/Library/Application Support/hfy_sync/config.json          {server, tree_name, dbid, media_root, client_instance_id}
~/Library/Application Support/hfy_sync/<dbid>/state.sqlite  sidecar (schema below)
~/Library/Application Support/hfy_sync/<dbid>/state.lock    fcntl.flock: one run at a time
~/Library/Application Support/hfy_sync/<dbid>/status.json   last run (atomic temp+rename)
~/Library/Application Support/hfy_sync/<dbid>/previews/<run_id>.json
~/Library/Application Support/hfy_sync/<dbid>/backups/<UTC>-<action>-seq<N>.sqlite (+ .sha256)
~/Library/Application Support/hfy_sync/<dbid>/logs/<run_id>.log   (no object content, IDs and paths only)
~/Library/Application Support/hfy_sync/<dbid>/cache/snapshot-<seq>.jsonl.gz
Keychain item: service "us.harrisonfamily.hfy_sync", account "<issuer>|<sub>" -> refresh token
~/Pictures/hfy-sync-media/<handle><ext>   media created in the cloud and pulled down
```

Sidecar DDL (stdlib `sqlite3`; `_sqlite3` ships in the bundle's `lib-dynload`):

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- sidecar_schema=1, tree_id, dbid, fingerprint, server, redaction_version, addon_version,
-- last_pull_seq, last_snapshot_sha256, last_push_at, client_instance_id
CREATE TABLE base (class TEXT NOT NULL, handle TEXT NOT NULL, version INTEGER NOT NULL, seq INTEGER NOT NULL,
  hash TEXT NOT NULL, obj_json TEXT, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (class, handle));
CREATE TABLE outbox (batch_key TEXT PRIMARY KEY, session_id TEXT, created_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','sent','acked','rejected')),
  request_json TEXT NOT NULL, response_json TEXT, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE conflicts (id TEXT PRIMARY KEY, class TEXT, handle TEXT, path TEXT, kind TEXT,
  base_json TEXT, cloud_json TEXT, local_json TEXT, state TEXT, decision TEXT,
  cloud_conflict_id TEXT, detected_at TEXT, resolved_at TEXT);
CREATE TABLE holds (class TEXT, handle TEXT, path TEXT, rule TEXT, detail TEXT, first_seen TEXT,
  PRIMARY KEY (class, handle, path, rule));
CREATE TABLE media_local (handle TEXT PRIMARY KEY, path TEXT, md5 TEXT, sha256 TEXT, size INTEGER, origin TEXT);
CREATE TABLE id_map (class TEXT, handle TEXT, old_id TEXT, new_id TEXT, kind TEXT, at TEXT);
CREATE TABLE runs (run_id TEXT PRIMARY KEY, action TEXT, mode TEXT, started_at TEXT, finished_at TEXT,
  result TEXT, exit_code INTEGER, counts_json TEXT, error_json TEXT, backup_path TEXT);
```

`status.json` (the contract the CLI wrapper, the gramplet and io read):

```json
{"schema":1,"run_id":"01J…","action":"sync","mode":"cli","dry_run":false,
 "started_at":"…Z","finished_at":"…Z","result":"ok|changes_pending|partial|refused|failed",
 "exit_code":0,"tree":{"dbid":"…","bound":true},
 "cloud":{"head_seq":0,"snapshot_seq":0},
 "counts":{"pulled":{"create":0,"update":0,"delete":0},"pushed":{"create":0,"update":0,"delete":0},
           "conflicts_open":0,"holds":0,"blocked":0,"media_up":0,"media_down":0},
 "backup":"…/backups/….sqlite","error":null,
 "next_action":"none|login|step_up|resolve_conflicts|retry|update_addon|open_bound_tree|close_gramps"}
```

---

## 5. Redaction projection v1 (R-19, R-18 data side, D-01)

`P(tree) -> {handle: projected obj} + holds` is a pure function of the whole local tree (it needs cross-object context: which events are birth-like, which places are street-level, which handles are private or held, every local full birth date). It lives in `gramps/hfygramps/projection.py`, is driven by the declarative `gramps/redaction/redaction-v1.json`, and has golden vectors in `gramps/redaction/vectors/` that the JS validator also runs. Rules are applied in this order.

### 5.1 Private flag (Gramps `PrivacyBase`)
- A primary object with `private: true` is excluded. If it was synced before, the desktop sends `withdraw` (a delete that needs no step-up because it reduces exposure).
- A secondary element with `private: true` is removed from its list: `alternate_names[]`, `event_ref_list[]`, `media_list[]`, `child_ref_list[]`, `attribute_list[]`, `urls[]`, `address_list[]`, `lds_ord_list[]`, `person_ref_list[]`, `reporef_list[]`, `SrcAttribute` lists. Lift re-inserts it.
- `primary_name.private == true` holds the whole person (a person cannot exist in the cloud without a name).
- References to excluded or held objects are filtered from `family_list`, `parent_family_list`, `note_list`, `citation_list`, `media_list`, `event_ref_list`, `child_ref_list`, `father_handle`/`mother_handle` (set to null), and `placeref_list`.
- Today: 0 private objects at any level (digest map 1), so v1 changes nothing on day one.

### 5.2 Dates of birth (R-19; applies to every person, living or not)
Birth-like event := `type.value ∈ {BIRTH 12, BAPTISM 15, BLESS 18, CHRISTEN 22, STILLBIRTH 45}` (`gramps/gen/lib/eventtype.py:116-147`, `is_birth_fallback` at `:327-332`), or `type.value == CUSTOM 0` with `type.string` matching `/birth|bapt|christen|naissance|geburt|nacimiento/i`, or any event that some person references at its `birth_ref_index`.

For every birth-like event, `Event.date` (Gramps `Date`, schema `gramps/gen/lib/date.py:776-800`) is projected:

| Field | Projection | Ownership |
|---|---|---|
| `dateval[0]` day, `dateval[1]` month | `0` | local-only |
| `dateval[4]`, `dateval[5]` (second day/month of RANGE/SPAN 8-tuples) | `0` | local-only |
| `dateval[2]`, `dateval[6]` years, slash flags | unchanged | shared |
| `text` | `""` | local-only |
| `modifier` | unchanged, except TEXTONLY 6 -> NONE 0 with the first 4-digit year extracted from text, else the whole date becomes empty | local-only when TEXTONLY |
| `sortval` | recomputed: `sdn(year,1,1)` in the date's calendar (`_calc_sort_value` with `_zero_adjust_ymd`, `date.py:1629-1633`, `:1823-1840`), or `0` when year is 0 or the calendar is not Gregorian/Julian | derived (excluded from merge) |
| `quality`, `calendar`, `newyear` | unchanged | shared |

Also local-only, whatever the event: attributes of type `AGE 10`, `FATHER_AGE 11`, `MOTHER_AGE 12`, `TIME 14` (`gramps/gen/lib/attrtype.py:50-66`) on persons, events and event refs; the whole `lds_ord_list` (ordinance dates include baptism).

Exact-DOB scan (desktop only, the cloud never knows the DOBs): the addon builds the set of local full birth dates and renders each in ISO, `M/D/YYYY`, `MM/DD/YYYY`, `D.M.YYYY`, `YYYY/MM/DD`, `Month D, YYYY`, `D Month YYYY` and three-letter-month forms. Any outgoing free-text field (5.4) containing any of them is held. Any other `Date` object on the same person's events, names or attributes that equals that person's full birth date is reduced as if birth-like.

### 5.3 Contact information (R-18 universal rule, data side)
| Where | Field | Projection |
|---|---|---|
| `Person.address_list[]`, `Repository.address_list[]` | every `Address` (street, locality, city, county, state, country, postal, phone, date, notes, citations) | local-only (whole list) |
| `Person.urls[]`, `Place.urls[]`, `Repository.urls[]` | element with `type.value == EMAIL 1`; or path scheme `mailto: tel: sms: callto: facetime: skype: whatsapp:`; or host in `{m.me, ig.me, wa.me, t.me, telegram.me, messenger.com, api.whatsapp.com, signal.me}` or path `instagram.com/m/…`; or path/desc with a scanner hit | element local-only |
| `Place.alt_loc[]` (`Location`) | `street`, `locality`, `postal`, `phone` | blanked (local-only); an element left with no fields is removed |
| `Place` with `place_type.value ∈ {STREET 7, BUILDING 19, NUMBER 20}` (`gramps/gen/lib/placetype.py:45-66`) | whole object | excluded; every reference to it (`Event.place`, `placeref_list[].ref`) is re-pointed to its nearest non-excluded ancestor via `placeref_list[0]`, or `""` |
| attributes `SSN 6`, `ID 3` | whole element | local-only (government identifiers) |
| Researcher metadata (`gramps/gen/lib/researcher.py:38-62`) | everything | never read by the addon |
| Media binaries | JPEG/PNG/TIFF with EXIF GPSLatitude/GPSLongitude | blob held ("remove location info, then sync") |

Today: 0 addresses, 1 person Url (WEB_SEARCH, shared), 0 place Urls, 0 street-level places (digest maps 1 and 5), so v1 changes nothing on day one except the researcher block, which was never exported.

### 5.4 Free-text scanning
Fields scanned: `Note.text.string`; `Event.description`; `Media.desc`; `Attribute.value`, `SrcAttribute.value`; `Url.desc`, `Url.path`; `Citation.page`; `Source.title/author/pubinfo/abbrev`; `Repository.name`; `PersonRef.rel`; `Name.first_name/call/nick/famnick/title/suffix`, `Surname.surname`; `PlaceName.value`, `Place.title`, `Place.code`; `Tag.name`.

Scanner kinds (one module, two ports: `api/src/guard/scan.js`, `gramps/hfygramps/scanner.py`; shared vectors; R-18 surfaces reuse the JS module): `phone` (≥ 7 digits in a 20-char window of digits and `+ ( ) - . space`, excluding year ranges and dates), `email`, `street_address` (number + street word + suffix list), `po_box`, `contact_url`, `dob_heuristic` (a day-precise date within 40 characters of `born|birth|b.|dob|birthday|baptized|christened`), and desktop-only `dob_exact`.

Outcome: on an existing synced object the field is **held**: the projection keeps the base (last-synced) value, so the local edit is simply not pushed, and the preview says why and where (rule + character offsets). On a new object the whole object is held, and references to it are filtered (5.1). `Note.text` (`StyledText {string, tags}`) is one atomic field: holding it keeps the base tags too.

### 5.5 Media
`Media.path` -> `""` (local-only: machine paths, folder names). `Media.checksum` -> MD5 of the bytes on disk when the file is readable and not a Dropbox placeholder (0 bytes or `com.dropbox.placeholder` xattr), else the stored value (`gramps/gen/utils/file.py:261-279`). Everything else per 5.1 to 5.4.

### 5.6 Invariants (tested as properties)
- `P(P(x)) == P(x)`.
- For every cloud object `C` that passes the server validator and every local `L`: `P(lift(C, L)) == C` (modulo derived `sortval`).
- No projected object ever contains a non-zero day/month on a birth-like event, an `Address`, an EMAIL Url, a non-empty `Location.street/locality/postal/phone`, `private: true`, or a scanner hit.

### 5.7 Server validator (same rules, detection only)
`api/src/sync/checker.js` rejects (422 `privacy_violation`, RFC 6901 pointers) any op violating 5.1 to 5.4, using `redaction-v1.json` and the JS scanner. It runs on every write, including the proposals/tagging domains' writes. The renderer (Python) re-runs the same checks on every output file and refuses to write a file that fails (fail closed, alarm).

---

## 6. Merge model (R-04)

### 6.1 Field ownership
- **shared**: synced both ways (most fields).
- **local-only**: never in the cloud; projection removes or blanks it; lift restores it from the local object (section 5 tables).
- **derived**: excluded from comparison and recomputed after lift: `change`, `Date.sortval`, `birth_ref_index`/`death_ref_index` (compared as `_birth_ref`/`_death_ref` = `"<event handle>#<occurrence>"` or null, re-indexed after merge), `Media.checksum` when the file was not readable.
- **held**: a shared field temporarily local-only because of a scan hit (5.4).

### 6.2 Merge view
Before comparing, each object is converted to a merge view:
- keyed lists become `{key: element}` plus `_order`: `Person.event_ref_list`, `Family.event_ref_list`, `*.media_list` (`MediaRef`), `Person.person_ref_list`, `Source.reporef_list`, `Place.placeref_list` keyed `ref#n` (n = occurrence among equal refs); `Family.child_ref_list` keyed `ref`;
- handle lists (`family_list`, `parent_family_list`, `note_list`, `citation_list`, `tag_list`) become ordered sets;
- identity-less value lists (`alternate_names`, `attribute_list`, `urls`, `Name.surname_list`, `Place.alt_names`, `Place.alt_loc`) become bags keyed by the canonical hash of the element (do not key names by position: Gramps Web lets users reorder them);
- atomic values: `StyledText`, `Date` (with the composite rule), every `GrampsType {value, string}`, `MediaRef.rect`.

### 6.3 Three-way rule per path
For each path with `b = B[path]` (base: cloud object at last sync, from the sidecar), `l = P(L)[path]`, `c = C[path]`:

| Condition | Result |
|---|---|
| `l == c` | converged (no-op; base advances to `c`) |
| `l == b`, `c != b` | take cloud (lift into the local object) |
| `c == b`, `l != b` | take local (included in the push op) |
| `l != b`, `c != b`, `l != c` | **conflict** |
| composite: `c != b` on a field whose local object has a local-only refinement (birth date with a local day/month; an event place whose local value is a street-level descendant; a held field) | **conflict** (`kind: composite`), even if `l == b` |

Keyed lists: per-key three-way on add/remove/modify, recursing into the element (so a `MediaRef.rect` edited on the web and a `MediaRef.note_list` edited on the desktop both survive). Order: if only one side reordered, take that order; if both, local order plus cloud-only keys appended (logged as an automatic resolution). Bags: three-way multiset add/remove; a base element removed on both sides with different replacements is a conflict (ambiguous pairing).

### 6.4 Object-level cases
| B | L | C | Result |
|---|---|---|---|
| absent | absent | present | create locally |
| absent | present | absent | push create |
| present | present | tombstone | if `P(L) == B`: delete locally (confirmation in the GUI; CLI only with `allow_deletes=1`); else conflict `delete_edit` |
| present | absent | present | if `C == B`: push delete (step-up); else conflict `delete_edit` |
| present | absent | tombstone | drop from the sidecar |
| absent | present | present | sidecar lost or first sync after rebase: converged if `P(L) == C`, else conflict (never auto-pushed) |

### 6.5 Lift
`lift(C, L)` starts from the cloud object and restores: local-only date parts (only when the shared year is unchanged; otherwise 6.3 already raised a composite conflict), `address_list`, filtered private/local-only list elements at their original relative positions, `lds_ord_list`, local-only attributes, `Media.path` (local path, or the downloaded file's path), held fields, street-level place refs (when `C`'s place is the local place's ancestor), then recomputes `birth_ref_index`/`death_ref_index` and `sortval`. Result -> `json_utils.data_to_object` (`gramps/gen/lib/json_utils.py:202`) -> `db.method("commit_%s", cls)` (`gramps/gen/db/base.py:1439`).

### 6.6 Relationship symmetry
After merging, before commit: `person.family_list ↔ family.father_handle/mother_handle` and `family.child_ref_list ↔ person.parent_family_list` must be symmetric, every referenced handle must exist, and indexes must be in range. A violation becomes an `integrity` conflict for the objects involved; the rest of the plan proceeds.

### 6.7 Conflicts
GUI: each conflict shows base, website value and desktop value (projected) with "Keep mine / Take website / Skip"; decisions apply in the same run. CLI: conflicts are parked in the sidecar and mirrored to `SYNC#CONFLICT#…` (projected values only); the conflicting fields keep their local values and are not pushed; everything else proceeds. An admin can record a decision on the web (phase B page); the addon applies it on the next run. No timestamps are used anywhere in the merge, so clock skew cannot change outcomes.

---

## 7. Cloud API

All routes live in hfy-api under `/api` (existing CloudFront behavior with `AllViewerExceptHostHeader`, so `Authorization` reaches the function: `scripts/infra/add-api-behavior.sh:47`). Errors use the house format `{error, message, details?}` (`api/src/http.js:24-33`).

### 7.1 Auth for `/api/sync/*`
- New route auth mode `sync-bearer` beside `session` (every route is stamped `auth: "session"` at `api/src/routes.js:129`; the handler authenticates by cookie only at `api/src/handler.js:80-81`; caps are generated from the registry at `api/src/routes.js:143`): RS256 via the edge JWKS (`api/src/auth.js:8-10`), issuer `https://harrisonfamily.us/auth`, `aud` must include `https://harrisonfamily.us/api/sync`, `client_id == "hfy-sync-desktop"`.
- Authorization: the S3 groups config, never the token's own `groups` claim (the MCP precedent, `api/src/mcp.js:105-106`). New group `gramps-owner` (`{"subjects": [<io's sub>]}`); `parseGroupsConfig` (`api/src/policy.js:44-51`) grows a generic group lookup. Fail closed.
- Step-up for any `delete` op: `amr` includes `mfa` and `now - auth_time ≤ 300 s` (`api/src/policy.js:18-24`; `auth_time` is never refreshed, HFY-R64).
- Flags: `SYNC_API_ENABLED` env (default `0` -> 404 `not_enabled`); `SYNC#HEAD.writes_enabled` (false -> 503 `sync_paused` on every write).
- Handshake headers on every call: `X-HFY-Sync-Client: hfy_sync/<semver>`, `X-HFY-Gramps-Version: 6.0.6`, `X-HFY-Gramps-Schema: 21`, `X-HFY-Redaction-Version: 1`, `X-HFY-Tree-Id: <uuid>`.

### 7.2 Routes

| Route | Purpose | Success | Errors |
|---|---|---|---|
| `GET /api/sync/meta` | handshake | `{api_version:1, min_client, accepted:{gramps:["6.0"], schema:[21]}, redaction_version:1, tree_id, bound:{dbid, fingerprint}, head_seq, rendered_seq, writes_enabled, limits:{max_ops:24, max_obj_bytes:204800, max_body_bytes:2097152}, id_block:{Person:"I8000-I8999",…}}` | 401, 403 `not_owner` |
| `POST /api/sync/bind` `{dbid, fingerprint, tree_name_sha256}` | bind the desktop tree (first time, or rebind with step-up) | `{tree_id}` | 403 `step_up_required` (rebind), 409 `already_bound` |
| `GET /api/sync/snapshot` | ARCH-C pull | `{seq, url (presigned GET, 300 s), body_sha256, count, generated_at}`; built on demand at the current head and cached per seq | 503 `retryable` |
| `GET /api/sync/changes?since=<seq>&limit=<1..500>` | ARCH-B pull (phase B) | `{ops:[{seq, op, class, handle, gramps_id, version, obj\|null, at, origin}], head_seq, next_since, dense:true}` | 400 `bad_cursor` (since > head), 410 `gap_too_large` (reserved; the log is kept forever) |
| `POST /api/sync/sessions` `{expected:["<Class>#<handle>",…]}` | open a multi-batch push (first seed, large edits) | `{session_id, expires_at}` | 409 `session_open` |
| `POST /api/sync/sessions/:id/complete` | close a session; verifies no dangling references; appends a `marker` log entry (triggers the render) | `{seq}` | 422 `integrity_violation` with the dangling refs |
| `POST /api/sync/batches` | push | `{batch_id, seq_from, seq_to, results:[{op_id, class, handle, version, seq, gramps_id}]}`; a replay returns the stored body with `Idempotent-Replayed: true` | 400 `validation`; 403 `step_up_required` / `tree_mismatch`; 409 `version_conflict` (with current version and redacted current object per op), `gramps_id_taken`, `reserved_id_block`, `renumber_blocked`, `exists`; 413 `batch_too_large`; 422 `privacy_violation`, `integrity_violation`, `idempotency_key_reused`, `unknown_class`; 426 `upgrade_required`; 428 `idempotency_key_required`; 503 `sync_paused` / `retryable` |
| `POST /api/sync/media/presign` `{handle, content_type, size, sha256_b64, md5_hex}` | blob upload | `{upload_url, headers:{"Content-Type", "x-amz-checksum-sha256"}, key, expires_in:300}` | 400 type/size (allowed: jpeg, png, gif, tiff, pdf; ≤ 25 MB) |
| `POST /api/sync/media/:handle/download` | blob download (pull) | `{url, sha256, md5, size, content_type}` | 404 `no_blob` |
| `POST /api/sync/status` | heartbeat after each run | 204 | — |
| `GET /api/sync/conflicts?state=open` and `POST /api/sync/conflicts/:id/decision` `{decision}` | conflict queue (owner bearer or hfy-admin cookie) | list / updated item | 404, 409 `already_resolved` |
| `GET /api/records/:class/:handle`, `GET /api/records/Person/by-id/:gramps_id` (member cookie) | read API for the editing/proposals/tagging domains | `{class, handle, gramps_id, version, obj}` + `ETag: "v<version>"` | 404 (tombstone or unknown) |

Push request body:

```json
{"tree_id":"…","session_id":null,"client_run_id":"01J…",
 "ops":[
  {"op_id":"1","op":"update","class":"Person","handle":"…","base_version":7,"obj":{"_class":"Person","handle":"…"}},
  {"op_id":"2","op":"create","class":"Event","handle":"…","base_version":null,"obj":{"_class":"Event","handle":"…"}},
  {"op_id":"3","op":"delete","class":"Note","handle":"…","base_version":2}
 ]}
```

Validation order (all ops must pass, the batch is atomic): handshake -> auth/group/step-up -> shape and limits -> JSON Schema per class (generated from Gramps `get_schema()`, `gramps/gen/lib/*.py`, committed as `gramps/schema/gramps-6.0.6.schema.json`) -> privacy checker (5.7) -> ID rules (GID uniqueness; desktop creates may not use the 8000-8999 block; a person's gramps_id may not change: `renumber_blocked`) -> integrity (refs exist in the store view, in this batch, or in the open session's expected set; symmetry for `web`/`proposal` origins is hard, for desktop pushes it is checked at session completion) -> transaction.

### 7.3 `applyBatch()` (internal interface for other domains)
`api/src/sync/apply.js` exports `applyBatch(ctx, {principal, origin, onBehalfOf?, idempotencyKey, ops})`. Web origins may omit `handle` (minted with Gramps' algorithm, `'%08x%08x' % (int(time*10000), rand)`, `gramps/gen/utils/id.py:52-58`) and `gramps_id` (minted from `SYNC#HEAD.id_next.<Class>` inside the same transaction, guarded by `GID#`). The proposals, tagging (R-31) and photo-graduation (R-02) domains write only through it, so validation, versions, audit and rendering are identical for every writer. `transact()` (`api/src/txn.js:32-38`) gains `Update`, `ConditionCheck` and `ClientRequestToken` (today Put/Delete only).

### 7.4 Store view
The API keeps an in-memory view of all heads per container (≈ 1-2 MB): cold start = latest snapshot + fold of `SYNC#LOG` since its seq (strongly consistent base-table Query); warm = fold since the cached seq after a consistent `GetItem` of `SYNC#HEAD`. GSI reads are never used for correctness. The same view serves integrity checks and on-demand snapshots.

---

## 8. Desktop addon `hfy_sync` (R-04, R-05)

### 8.1 Code location and packaging (SYNC-04)
```
harrisonfamily/gramps/
  hfy_sync/                    Gramps addon folder (GPL-2.0-or-later headers; private use)
    hfy_sync.gpr.py            register(TOOL, id="hfy_sync", category=TOOL_DBPROC,
                               tool_modes=[TOOL_MODE_GUI, TOOL_MODE_CLI], gramps_target_version="6.0")
    hfy_sync_tool.py           Tool + ToolOptions (plain Tool, not BatchTool: keeps undo, tool.py:111-137)
    ui/                        Gtk 3 dialog builders
    hfy_sync_gramplet.py       phase B
  hfygramps/                   pure-stdlib core: canonical, projection, merge, lift, scanner, checker,
                               rules, dates (sdn), ids, render/ (transforms ported from the ETL)
  redaction/redaction-v1.json, redaction/vectors/*.json
  schema/gramps-6.0.6.schema.json (generated)
  bin/hfy-sync                 CLI wrapper (runs Gramps CLI, maps status.json to an exit code)
  scripts/build-addon.sh       vendors hfygramps into hfy_sync/ and zips dist/hfy_sync-<ver>.zip
  scripts/install-addon.sh     installs into ~/Library/Application Support/gramps/gramps60/plugins/hfy_sync
  tests/unit (stdlib unittest; CI)  tests/gramps (bundle shim; local macOS)  tests/e2e (dev server)
  tests/fixtures/make_synthetic_tree.py, synthetic-tree.gramps (fictional data only)
```
Runtime: Gramps' embedded Python 3.13.2 has `_ssl`, `_sqlite3`, `_hashlib`, `PIL`, `orjson`, no `certifi` (checked in the bundle). HTTP uses `urllib` with `ssl.create_default_context()`, falling back to `cafile=/etc/ssl/cert.pem` when the default store is empty; verification is never disabled. The core stays compatible with Python 3.12 so CI's stock `python3` runs the unit tests without installs.

### 8.2 Modes
- **GUI**: Tools > Family Tree Processing > "Website sync…" (section 13.1). Runs inside the open tree.
- **CLI**: `Gramps -O "<tree>" -a tool -p name=hfy_sync,action=<status|login|check|pull|push|sync|bind>,dry_run=<0|1>,allow_deletes=<0|1>,yes=<0|1>`, wrapped by `gramps/bin/hfy-sync <action> [--yes] [--allow-deletes]`. CLI `sync` is a dry run unless `--yes`. CLI never resolves conflicts and never applies mass deletes.

### 8.3 Run sequence (`sync`)
1. **Preflight** (refuse, never partially run): take `state.lock` (flock); sidecar `PRAGMA integrity_check` and schema version; local Gramps schema version must be in the addon's supported list (21); CLI: refuse if `--force-unlock`/`-u` is in `sys.argv`, refuse if another Gramps GUI process is running (`ps` scan for `Gramps.app/Contents/MacOS/Gramps` without `-a`); any future direct-API mode refuses when `<dbdir>/lock` exists; tree binding: `db.get_dbid()` (`gramps/gen/db/base.py:1410`) and the fingerprint (sha256 of sorted handles at bind time, then tracked) must match the cloud's `bound`; handshake `GET /api/sync/meta` (426/409 -> refuse); disk space ≥ 3 × DB size + 100 MB; access token valid (refresh if needed).
2. **Resolve outbox**: any `sent` batch without an ack is re-POSTed with the same `Idempotency-Key`; the server replays the stored result; base advances.
3. **Pull**: `GET /api/sync/snapshot` -> download -> verify `body_sha256`, header `tree_id`, schema, redaction version, count; refuse if `seq < last_pull_seq` (rollback protection).
4. **Plan**: load all local objects (`get_raw_*_data` -> dict), compute `P(L)`, merge with `B` (sidecar) and `C` -> `{local_apply, push_ops, conflicts, holds, blocked}`.
5. **Preview**: GUI shows it and waits; CLI with dry run writes `previews/<run_id>.json`, updates `status.json` (`changes_pending`, exit 10) and stops. Dry run writes nothing to the Gramps DB, the sidecar base, or the cloud.
6. **Media down** for cloud-created or changed Media in the plan: presigned GET, verify sha256/md5, write to `media_root`, record in `media_local`. Done before the backup so the one local transaction can set `Media.path`. A failed download defers only that Media object (and the refs to it) to the next run.
7. **Backup**: SQLite Online Backup API from a separate read connection to `<dbdir>/sqlite.db` (Gramps' own connection is private, `gramps/plugins/db/dbapi/sqlite.py:85-107`) into `backups/…sqlite`, then `PRAGMA integrity_check` == `ok` and sha256 recorded. No backup, no apply. Retention: last 20 plus one per day for 30 days.
8. **Stale check**: re-read every object the plan touches; if any local hash changed since step 4 (io edited during the preview), re-plan and re-preview.
9. **Apply locally** in one non-batch transaction: `with DbTxn(_("Website sync: pull seq %d") % S, db) as trans:` (`gramps/gen/db/txn.py:68-85`); creates/updates via `db.method("commit_%s", cls)(obj, trans)`, deletes via `remove_*`; then the symmetry/reference check (6.6) inside the block; any exception aborts the whole transaction (nothing applied, nothing pushed). In the GUI the transaction is one Edit > Undo entry for the session.
10. **Update base** for every applied or converged object (sidecar transaction).
11. **Media up**: for each Media create/update whose blob differs from the cloud's `blob.md5`, presign + PUT with `x-amz-checksum-sha256`; a Media op is sent only after its blob verified.
12. **Push**: open a session when the push needs more than one batch; batches of ≤ 24 ops in dependency order (Tag, Place, Note, Source, Repository, Citation, Media, Event, Person, Family; deletes last, in reverse order); each batch's request and `Idempotency-Key` are written to the outbox (`pending` -> `sent` -> `acked`) before sending; complete the session. On 409 `version_conflict` stop pushing, mark `partial`, and (GUI) re-run from step 3 up to 3 times.
13. **Finish**: write `status.json`, `POST /api/sync/status`, prune backups.

Crash safety: every step after 9 is idempotent, and the merge's "converged" rule absorbs a crash between the Gramps commit and the sidecar update (`P(L) == C` on the next run). A crash during the Gramps commit is rolled back by SQLite's journal (journal_mode delete); the pre-apply backup covers real corruption.

### 8.4 Push ops and identity
- A local gramps_id change on a synced Person is `blocked` (`renumber_blocked`); the GUI offers "Restore website ID locally" (applied in step 9). Non-person renumbers push normally (their site files are keyed by handle).
- Merge detection: a deleted Person whose old gramps_id appears in a surviving Person's `Merged Gramps ID` attribute in the same push = merge. GUI-only, needs step-up; the server writes `IDALIAS#Person#<old>` and the renderer writes `person/<old>.json = {"mergedInto":"<new>"}`; the identity domain re-keys comments and allowlist entries.
- A desktop create whose gramps_id is in the 8000-8999 block is held (`reserved_id_block`).

### 8.5 Auth (SYNC-05)
`hfy-sync login` (or the GUI "Sign in…" button): PKCE S256 + `state`, a one-shot `http.server` on `127.0.0.1:53682`, `webbrowser.open(https://harrisonfamily.us/auth/authorize?client_id=hfy-sync-desktop&resource=https://harrisonfamily.us/api/sync&…)`, 5-minute timeout, code exchange at `/auth/token`. The refresh token is written with `security -i` reading the command on stdin (never on argv) and read with `security find-generic-password -w`; the access token stays in memory. Refresh tokens rotate (`auth/src/oauth.js:164-179`); the new one is persisted before use; a reused token revokes the family and the addon asks for sign-in. `login --step-up` adds `prompt=login&max_age=300`.

### 8.6 Schema-version handshake
The addon refuses before reading anything when the local DB schema is not 21 or the Gramps major.minor is not 6.0. The server refuses (426) when the client version is below `min_client` or the client's schema is not in `accepted_schema`, and (409 `redaction_version_mismatch`) when redaction versions differ. Every head carries `schema` and `redaction`. A Gramps upgrade to a new schema needs a new addon release and a server `accepted_schema` change; until then sync is refused on both sides (runbook 19.6).

### 8.7 CLI exit codes (wrapper)
| Code | Meaning | `next_action` |
|---|---|---|
| 0 | in sync, or changes applied | none |
| 10 | dry run found changes | — |
| 20 | partial: conflicts parked or fields held | resolve_conflicts |
| 64 | usage (bad options, `--force-unlock`) | — |
| 65 | server refused data (privacy/integrity) | open preview |
| 69 | sync paused (kill switch) or not enabled | — |
| 70 | internal error, or `status.json` missing/stale (`run_id` mismatch) | report |
| 75 | temporary: tree open in the GUI, cloud moved (409), network, lock held | retry / close_gramps |
| 77 | sign-in or step-up needed | login / step_up |
| 78 | configuration: wrong tree, unsupported schema, upgrade required | open_bound_tree / update_addon |

---

## 9. Media sync and MediaRef rect preservation (R-31 data side)

- **Tag architecture duplicated as-is**: a photo tag is a `MediaRef` in `Person.media_list` (also Family/Event/Source/Citation media lists) with `ref` (Media handle), `rect` (`null` or 4 integers 0-100, `gramps/gen/lib/mediaref.py:119-129`), `private`, `attribute_list`, `note_list`, `citation_list`. The store keeps exactly that. Web tagging is an `update` op on the tagged person's `media_list` through `applyBatch()`.
- **Validator**: `rect` is `null` or `[x1,y1,x2,y2]` integers with `0 ≤ x1 < x2 ≤ 100`, `0 ≤ y1 < y2 ≤ 100`; `[0,0,100,100]` must be sent as `null` (Gramps' own normalisation, `editmediaref.py:594-610`); floats are rejected. The float-to-integer rounding of a web tagger (outward rounding) is the tagging domain's job before it calls `applyBatch()`.
- **Merge**: elements keyed `ref#n`; `rect` is an atomic field of the element, so a rect changed on one side and a note changed on the other both survive; both rects changed differently is a conflict.
- **Round trip**: integers are copied byte-for-byte both ways; a property test pushes and pulls 100 random rects and requires identity.
- **Blobs**: key `media/<handle><ext>` (today's `s3Key`); presign signs `Content-Type` and `x-amz-checksum-sha256` (S3 rejects a mismatched body; works for SSE-S3 and SSE-KMS alike, unlike the ETag-equals-MD5 shortcut); the server records `blob.{sha256, md5, size}` after a `HeadObject` with checksum mode. The API role needs `s3:PutObject`/`GetObject` on `media/*` (today only `uploads/posts/*`, `app-stack.yaml:97-100`).
- **Placeholders and missing files**: 0-byte files, the Dropbox placeholder xattr, unreadable paths: metadata still syncs; blob held; never overwrite a good cloud blob with an empty one. 14 of 29 Dropbox record files are placeholders today (digest gap-fill 4), so the runbook asks io to mark the media folders "Available offline" before the seed.
- **Base path mapping**: `Media.path` never leaves the Mac. Cloud-created media are downloaded to `media_root` (default `~/Pictures/hfy-sync-media/`, configurable) as `<handle><ext>`; the sidecar `media_local` maps handle -> local path. io may move files and repoint paths in Gramps; that is a local-only change and is never pushed.
- **Formats**: HEIC/WebP are not accepted by the sync presign (Gramps 6.0.6 on macOS cannot thumbnail or region-edit them, digest gap-fill 2); the photo-graduation domain converts to JPEG with orientation baked in before creating the Media object.

---

## 10. Gramps IDs, merges and renumbering

- **Sync key** is the handle everywhere. Handles are globally unique without coordination (`gramps/gen/utils/id.py:52-58`). `commit_*` with a preset handle inserts it (`_commit_base` updates or inserts).
- **Desktop-created objects** keep Gramps' normal allocation (`find_next_*_gramps_id`, `gramps/gen/db/base.py:182`); next local person IDs fill gaps from <gramps-id> upward.
- **Cloud-created objects** (proposals, sign-ups, graduated photos) get permanent IDs from the reserved block `<prefix>8000-<prefix>8999` (SYNC-03): `I`, `F`, `E`, `P`, `O`, `N`, `S`, `C`, `R`. Why this works: it matches the stored `I%04d` format, so a default Reorder Gramps IDs keeps it (digest gap-fill: in-range IDs that do not collide survive); it satisfies every ID pattern in the code (`api/src/notify.js:17`, `islands/src/lib/comments-ui.jsx:13`, `api/src/labels.js:12`, `api/src/comments.js:9`, `build_family_tree_media.py:158-159`); local minting needs ≈ 7,700 more adds to reach it. Why not a letter prefix: `set_prefixes` is per session and Reorder rewrites any non-matching prefix (digest gap-fill).
- **Guards**: `GID#<Class>#<id>` uniqueness in the cloud; the addon warns when a local counter comes within 200 of 8000; the runbook forbids Reorder's "Change" mode.
- **Merges** (8.4) produce `IDALIAS` items and `mergedInto` stubs. **Renumbers** of persons are blocked; the alias path exists for a future io-approved renumber.
- **Reserved names**: the validator rejects gramps_ids `index`, `search-index`, `search-store` (they are file names under `person/`).

---

## 11. Rendering from the store; retiring `aws s3 sync --delete`; D-02 fixes

### 11.1 Renderer
`lambda/hfy-sync-render/` (Python 3.13, arm64, 1024 MB, 300 s, reserved concurrency 1), event source = table stream (`StreamViewType: KEYS_ONLY`) with `FilterCriteria {"dynamodb":{"Keys":{"PK":{"S":["SYNC#LOG"]}}}}`, batch window 5 s, bisect on error, 5 retries, SQS on-failure destination, alarms on DLQ depth and on `RenderError`/`RenderPrivacyBlock`/`MassDeleteGuard` metrics. Per invocation: read `SYNC#HEAD.seq`; skip if `seq ≤ rendered_seq`; skip (do not advance) while a push session is open and younger than 10 minutes; build the store view (snapshot + log fold); **full deterministic render** of every renderer-owned key with `hfygramps.render`; privacy re-check of every output (5.7 plus: no `sortValue` key anywhere, no day/month in any `date.text`, no `sourcePath`); compare sha256 with `render/manifest.json`; write changed keys and delete keys that left the desired set; update the manifest after each successful write; write `SYNC#RENDERED/<seq>` with changed/deleted people; set `rendered_seq`. `generatedAt` in the index files is the `at` of the head change, so re-renders are byte-stable.

Modes (`RENDER_MODE` env): `off` (default), `shadow` (writes to `s3://harrisonfamily-sync/render-shadow/`), `live`.

Guards: deletes > max(10, 10 % of the manifest) in one pass -> refuse all deletes, alarm, operator override payload `{"allow_mass_delete": true}`; keys under data prefixes that the renderer did not write ("foreign", e.g. stale legacy files) are reported, never deleted, unless an operator passes `{"prune_foreign": true}` after review.

### 11.2 Contract (BRD D-10 kept additively)
Person, family, event, note, place and media JSON keep every field the site reads (`11ty/js/person-page.js:326-363, 539-568, 605, 700, 1093-1096`; `islands/src/islands/person.jsx:32-44`; `islands/src/lib/people-corpus.js:5-6`). `person/index.json` and `person/search-index.json` keep `build_search_index.js`'s shapes (ported to Python). `isLiving` keeps today's rule (SYNC-15). Dates stay year-only on publish (HFY-R76) regardless of what the store holds.

### 11.3 D-02 export defect fixes (renderer)
| Defect | Today | Fix |
|---|---|---|
| Notes empty | reads `text._string/_tags` (`note_tags.py:152-158`) | read `text.string`/`text.tags` (Gramps 6), fall back to `_string/_tags`; `raw` + `html` via the existing tag markup |
| Event types lost | `coerce_event_type` ignores `{value:int}` (`transform.py:94-109`) | `type: {string, code}` with the English label from the committed EventType table (custom: `string`); person event `label` = type label (Birth, Death, Marriage, Residence, …) instead of index-based Birth/Death/Event (`transform.py` `event_label`) |
| Regions dropped | `media_refs = [ref …]` (`transform.py:324`) | `mediaGallery[].region [x1,y1,x2,y2] \| null` (four integer percents, as Gramps stores the rect) and `primaryPhoto.region` in the same shape; `media/<handle>.json.regions[] = {person:{handle, grampsId, displayName}, rect, attributes, notes}`, with `rect` the same `[x1,y1,x2,y2]` array |
| Family type, frel/mrel, family events missing | `build_family_payload` (`transform.py:150-185`) | `family.type {code, string}`, `children[].frel/mrel {code, string}`, `family.events[]` (with role), and the same on `familyTree.*Families` |
| Place type is a raw int | `transform.py:87` | `{code, string}` with the English PlaceType label |
| Local paths leak | `sourcePath` (`transform.py:342`) | dropped (no reader in the site) |

Notes going from empty to visible is a real exposure change: the shadow parity report lists, on io's Mac only, which notes become visible; the projection's scanner has already held any with contact info or DOB patterns.

### 11.4 Retirement sequence (safe)
1. Until cutover the HFY-R76-patched ETL stays the publisher; io should not run it during the migration window.
2. Shadow render and parity report (W5); io approves.
3. Cutover: `RENDER_MODE=live`, full render, first-pass mass-delete guard on (expected deletes: 0).
4. Bucket-policy deny on `s3:PutObject`/`s3:DeleteObject` for `harrisonfamily-frontend/{person,family,event,note,place}/*` and `media/*.json` for every principal except the renderer role, the hfy-api role (binaries only) and a new `hfy-data-breakglass` role (MFA-assumable by io). The CI deploy role is unaffected (its sync excludes these prefixes, `ci.manifest.yaml:21-29`). A legacy `aws s3 sync --delete` then fails with AccessDenied instead of overwriting.
5. The Dropbox `sync_to_s3.py` and `export_person_data.py` get a top-of-file refusal ("retired, see docs/how-to/sync-gramps-with-the-website.md") with a `--legacy-break-glass` escape; `docs/how-to/refresh-the-family-data.md` is rewritten.
6. Rollback: `RENDER_MODE=shadow`, remove the deny statement, the R-76 ETL can republish through the break-glass role.

### 11.5 Tree SVGs
`media/tree_<id>.svg` are rendered by `build_family_tree_media.py` from the raw DB with Graphviz. They are not renderer-owned in v1; the renderer adds `familyTreeMedia` only when the SVG key exists (ListBucket on prefix `media/tree_`). Cloud-created people get no tree until the visualization domain (R-22) decides the replacement; task `tree-svg-ownership` records that decision.

---

## 12. D-01 and D-03

### 12.1 D-01 (done; residuals)
Done by HFY-TSK-090 (HFY-R76): live `person/*.json` and `event/*.json` carry no `sortValue` and no day/month `date.text`. Residuals (task `d01-scrub-closeout`):
1. Verify by a signed-in read-only fetch of every live person and event file: 0 `sortValue` keys, 0 day/month `date.text` (counts only).
2. `get-bucket-versioning` on `harrisonfamily-frontend`. If versioning is or was enabled, noncurrent versions of the scrubbed keys still hold the day-precise values; with io's approval (SYNC-13) delete exactly those noncurrent versions and re-count (0).
3. Cache: gated responses are `private, no-store` (HFY-R65), so neither Cloudflare nor CloudFront holds copies; record the check.
4. List (paths and counts, to io only) the local Dropbox copies that still hold day-precise dates (`<project>/workspace/etl-output`, `<project>/workspace/harrisonfamily-frontend`, `<project>/repo`).
5. Structural prevention afterwards: projection (5.2), server validator (5.7), renderer re-check (11.1) and the bucket guard (11.4).

### 12.2 D-03 (task `d03-gitignore-guard`)
- `.gitignore` in harrisonfamily (today it has no data rules): ignore `etl-output/**`, `harrisonfamily-frontend/**`, `workspace/**`, `workspace-local/`, `gramps_exports/*` with negations for the 13 committed sample/README paths plus `workspace/11ty-dev/src/_data/featureFlags.js` (14 tracked files today); ignore `*.gramps`, `*.gpkg`, `**/sqlite.db`, `*.sqlite`, `*.db` everywhere except `!gramps/tests/fixtures/**`; ignore `**/hfy_sync/*/backups/`, `**/state.sqlite`.
- `scripts/ci/check-no-family-data.sh` + `scripts/ci/data-sample-allowlist.txt` (path + sha256): fails when a tracked file under a data dir, or any `*.gramps`/`*.sqlite`/`*.db`, is not on the allowlist; added to `ci.manifest.yaml` `tests` and to `scripts/git-hooks/pre-commit` (which today runs only the deployment-sync check and trufflehog).
- `scripts/export_workspace_samples.sh` (it rsyncs real `workspace/{etl-output,harrisonfamily-frontend}` into `<project>/repo`, lines 5-21) is removed; `docs/how-to/refresh-the-sanitized-samples.md` is updated.
- The old Dropbox checkout `<project>/repo` (HEAD ef08089, 1276 untracked + 7 modified real-data files) is not touched by the PR. The PR carries a paste-ready step for io: append the same patterns to `<project>/repo/.git/info/exclude`. Moving the real-data folders out of Dropbox is recommended, not performed (SYNC-14).

---

## 13. UX

### 13.1 Desktop: Gramps dialog ("Website sync…")
```
┌ Website sync ───────────────────────────────────────────────────────────────┐
│ Tree: <tree name>   Website: harrisonfamily.us   Signed in as: <label>      │
│ Last sync: <relative time>, ok      Website version: seq 1234 (rendered ✓)   │
│ [Sign in…] [Check for changes] [Open backups] [View log]                     │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▸ From the website (3)        create 1 · update 2 · delete 0                │
│     Person I8000  new  (proposal approved by <admin label>)                  │
│     Person I9001  primary_name.nick: "—" → "…"                               │
│ ▸ To the website (5)          update 4 · delete 1 (needs fresh sign-in)     │
│ ▸ Conflicts (1)                                                              │
│     Event E9001 date (birth year): base 19xx · website 19yy · yours 19xx     │
│       (•) Keep mine  ( ) Take website  ( ) Skip for now                     │
│ ▸ Held back (1)   Note N9001 text: phone number at chars 34-46. Edit it in   │
│                   Gramps to publish.                                          │
│ ▸ Blocked (0)                                                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ A backup is taken before anything changes. Undo is available until you close│
│ the tree; undoing will revert these changes on the website at the next sync. │
│                                         [Cancel]  [Apply 3 · Push 5]         │
└──────────────────────────────────────────────────────────────────────────────┘
```
- Rows expand to field-level diffs (path, base -> website, base -> yours). Values shown are projected values plus the local-only part only for "yours" (it never leaves the Mac).
- Incoming deletes and mass operations get a modal listing every object.
- After apply: a result banner (counts, backup path, any partial state with the next action). In the GUI the `DbTxn` emits Gramps' normal signals, so the views refresh.
- Phase B gramplet (sidebar): "Website: 3 changes waiting · Last sync 2 days ago · [Sync…]", polling `/api/sync/meta` at most every 5 minutes while visible, no writes.

### 13.2 CLI
```
$ hfy-sync check
website seq 1234 · from website: 1 create, 2 updates · to website: 4 updates · conflicts: 1 · held: 1
preview: ~/Library/Application Support/hfy_sync/<dbid>/previews/01J….json   (exit 10)
$ hfy-sync sync --yes
backup ok · applied 3 · pushed 4 · parked 1 conflict (resolve in Gramps) · held 1   (exit 20)
```

### 13.3 Web (phase B, admin only, flag `syncStatusV1`, default off per HFY-R8/R42)
`/admin/sync/` for `hfy-admin` and `gramps-owner`: cards for Desktop (last run, result, addon/Gramps versions), Website (head seq, rendered seq, render lag, last render error), Conflicts (each: record label, field, website value vs desktop value, "Keep website" / "Keep desktop"), Recent batches (who, origin, counts). At **375 px** cards stack in one column, buttons are full width at 44 px, values wrap (no horizontal scroll); at ≥ 64 rem a two-column grid (cards left, conflicts right). D-11 audit (16 px inputs, 44 px targets, axe clean, installed iPhone PWA) before the flag flips. No member-facing sync UI.

---

## 14. Kit changes and flags

io-kit: **none required.** The API, auth server, validator and renderer are HFY code (Q-3). Optional reuse with no kit change: `@io-kit/feed` `DeltaResponse` types for `/api/sync/changes`; `@io-kit/gates` `renderCard`/`GateSourceLike` pattern for the phase-B conflict list.

Flags and switches:
| Switch | Where | Default | Flips when |
|---|---|---|---|
| `SYNC_API_ENABLED` | hfy-api env | `0` | W4 deploy, before seed |
| `writes_enabled` | `SYNC#HEAD` | `false` | after bind, for the seed |
| `RENDER_MODE` | renderer env | `off` | `shadow` at seed, `live` at cutover (io G-prod) |
| `syncStatusV1` | site flags | off | after its D-11 audit + io approval |
| `changes_feed` | addon config | off | W6 |

---

## 15. Testing (never the live DB)

- **Unit (CI, stdlib `unittest`, Python 3.12/3.13)**: canonical JSON, projection (every rule, golden vectors), merge (every table row in 6.3/6.4, composite rule, keyed/bag/order merges), lift, scanner, dates/sdn, ID rules, renderer goldens.
- **JS (vitest, CI)**: checker on the same vectors (cross-language parity: the vectors carry expected verdicts), applyBatch with the fake DynamoDB (`txn.js` fake grows Update/ConditionCheck/CancellationReasons), routes and every API error row, OAuth multi-client.
- **Gramps integration (local macOS, bundle)**: `gramps/tests/gramps/run.sh` creates a temp `GRAMPSHOME`, imports `synthetic-tree.gramps` once into a template tree with the Gramps CLI, then copies the tree directory per test ("fixture DB copies"); installs the addon into the temp plugins dir; drives `Gramps -O <copy> -a tool -p name=hfy_sync,…`. Covers lock refusal, wrong-tree refusal, backup + integrity, single DbTxn, undo entry, stale re-plan, fault injection at 6 points (after backup, mid-apply, after commit before sidecar, after push before ack, after media PUT before op, mid-session).
- **Synthetic fixture** (`make_synthetic_tree.py`, fictional only): full DOBs, baptism/christening/blessing/stillbirth events, a TEXTONLY birth date, a span date, a custom event type, an Address, an EMAIL Url and a contact-channel Url, a phone and an email in notes, a street-level place with `alt_loc` street fields, private objects and private secondary elements, media refs with rects (incl. two tags of one person in one photo), merged-ID attributes, families with every frel/mrel, family events, styled note tags, a repository with an address, AGE/SSN/TIME attributes, a Dropbox-placeholder-like 0-byte file, and a JPEG with EXIF GPS. Uses reserved/fictional values only (555-01xx phones, example.org mail, documentation addresses).
- **E2E (local)**: `api/scripts/sync-dev-server.mjs` runs `createHandler` with the in-memory table, a local directory as S3 and a dev JWKS/token signer; `gramps/tests/e2e/` scenarios: seed via session, desktop edit push, web edit via `applyBatch`, pull, every conflict kind, deletes with/without step-up, merge -> alias, renumber blocked, media round trip with rects, lost-response replay, privacy hold never reaching the server (the dev server logs request bodies and the test greps them).
- **Shadow on io's Mac**: `hfy-sync check` against prod with a copy of the live tree before the seed (counts only leave the machine); shadow render parity report reviewed by io.
- **Renderer**: golden site output from the fixture store; byte parity with the R-76 Dropbox ETL on the fixture before the D-02 fixes; privacy re-check rejects planted violations; mass-delete guard.

---

## 16. Rollout

| Wave | Content | Gate |
|---|---|---|
| W0 | `d01-scrub-closeout`, `d03-gitignore-guard` | io approves noncurrent-version deletion (SYNC-13) |
| W1 | renderer port + D-02 fixes, redaction v1 (+ io approval of SYNC-02), scanner, schema export, `transact()` extension, OAuth multi-client | SYNC-02, SYNC-03 approved by io before W2 merges |
| W2 | projection, merge engine, store/applyBatch, validator, sync infra (stack change set: sync bucket, stream, renderer, roles) | orchestrator deploys stack with io G-prod |
| W3 | sync routes, records read API, renderer Lambda, addon skeleton, transport/auth, dev harness | `SYNC_API_ENABLED=0` in prod |
| W4 | addon pull/apply, push, media, GUI preview | e2e green; Gramps-integration suite green locally |
| W5 | seed + shadow (io), cutover (live render + bucket guard + legacy refusal), first round-trip UAT, docs/runbook | io G-prod at seed and at cutover |
| W6 | changes feed (ARCH-B), gramplet, admin status page (flag), merge alias redirect, tree SVG ownership | D-11 audit + io approval for `syncStatusV1` |

Rollback per stage: W2/W3 are dark (flags off). Seed: `writes_enabled=false`, store items can be ignored (renderer off/shadow). Cutover: `RENDER_MODE=shadow`, remove the bucket deny, republish with the R-76 ETL via break-glass. Desktop: restore the pre-apply backup (runbook 19.5).

---

## 17. Error-handling catalog

Desktop (addon):

| ID | Failure | Detection | Behaviour | Recovery |
|---|---|---|---|---|
| D01 | Tree open in the GUI during a CLI run | Gramps CLI lock refusal (`arghandler.py:566-576`) or `ps` scan | refuse, exit 75, `next_action: close_gramps` | close Gramps or use the GUI tool |
| D02 | `--force-unlock` passed | `sys.argv` check | refuse, exit 64 | rerun without it |
| D03 | Wrong tree | dbid/fingerprint ≠ cloud `bound` | refuse, exit 78 | open the bound tree; rebind needs step-up |
| D04 | Local schema not 21 / Gramps not 6.0 | `db` version check | refuse before reading, exit 78 | update the addon first |
| D05 | Addon too old / redaction mismatch | 426 / 409 | refuse, exit 78 | install the new addon |
| D06 | Not signed in, refresh expired or revoked (rotation reuse) | 401, `invalid_grant` | stop, exit 77 | `hfy-sync login` |
| D07 | Delete ops without fresh step-up | 403 `step_up_required` | push everything else; park deletes | `hfy-sync login --step-up`, rerun |
| D08 | Network/DNS/timeout/5xx | exceptions, 503 `retryable` | retry idempotent calls 3× (1 s, 4 s, 16 s); nothing applied before verification | rerun later, exit 75 |
| D09 | TLS verification failure | `ssl.SSLError` | fail closed, exit 75 | check clock and network; never disable verification |
| D10 | Snapshot corrupt/truncated/wrong tree/wrong schema | sha256/header check | discard, retry once, then fail exit 75 | rerun |
| D11 | Snapshot older than last pull | `seq < last_pull_seq` | refuse (rollback protection) | wait; operator checks the store (S17) |
| D12 | Sidecar missing | no `state.sqlite` | rebase mode: converged objects re-based, the rest become conflicts; CLI refuses, GUI resolves; nothing auto-pushed | resolve in the GUI |
| D13 | Sidecar corrupt / newer schema | `integrity_check`, schema version | move aside, as D12 / refuse | as D12 / update addon |
| D14 | Concurrent run | `state.lock` held | refuse, exit 75 | wait |
| D15 | Low disk space | preflight | refuse | free space |
| D16 | Backup fails or fails `integrity_check` | backup step | refuse to apply | fix disk/permissions, rerun |
| D17 | True conflicts | merge | GUI asks; CLI parks (sidecar + `SYNC#CONFLICT`), exit 20 | resolve in the GUI or decide on the web |
| D18 | io edited during the preview | stale hash re-check | re-plan, re-preview | — |
| D19 | Apply raises / symmetry check fails | exception inside `DbTxn` | transaction aborts, nothing applied, no push, exit 70 | report; local DB unchanged |
| D20 | Crash or power loss during commit | SQLite journal on reopen | DB rolls back to pre-apply; sidecar unchanged | rerun; if the DB is damaged, restore the backup (19.5) |
| D21 | Crash after commit, before sidecar update | next run sees `P(L) == C` | converged, base advances | none |
| D22 | Cloud moved between snapshot and push | 409 `version_conflict` | stop pushing, `partial`; GUI re-runs ≤ 3× | rerun, exit 75 |
| D23 | Response lost after the server committed | outbox `sent` without ack | replay same `Idempotency-Key` -> `Idempotent-Replayed` | none |
| D24 | Server privacy refusal (projection bug or rule drift) | 422 `privacy_violation` with pointers | drop offending ops, mark held with the server's rule, push the rest, warn | file a bug; fix rules/addon |
| D25 | Dangling references at session completion | 422 `integrity_violation` | hold dependants, re-push | rerun |
| D26 | gramps_id collision / reserved block | 409 `gramps_id_taken`, `reserved_id_block` | hold the object | renumber the unsynced local object |
| D27 | Kill switch | 503 `sync_paused` | stop, exit 69 | wait for io/operator |
| D28 | Idempotency key reused with another payload (bug) | 422 `idempotency_key_reused` | mark outbox entry rejected, recompute, new key | — |
| D29 | Media missing / Dropbox placeholder / unreadable | size 0, xattr, `OSError` | metadata syncs, blob held | make the folder available offline |
| D30 | Stored Gramps MD5 stale | disk MD5 ≠ stored checksum | use disk MD5, warn | run Check & Repair |
| D31 | Blob upload fails (expired presign, checksum mismatch) | S3 4xx | one retry with a new presign, else defer the Media op | rerun |
| D32 | Photo has GPS EXIF | PIL EXIF read | blob held with guidance | remove location info, rerun |
| D33 | Downloaded blob checksum mismatch | sha256/md5 verify | discard, retry, else defer that Media | rerun |
| D34 | Media root not writable | `OSError` | defer media pulls | fix folder/config |
| D35 | Local renumber of a synced person | gramps_id changed on same handle | blocked; GUI offers local restore | restore, or io-approved renumber later |
| D36 | Local person merge | deleted person's ID in survivor's `Merged Gramps ID` | GUI confirmation + step-up; CLI parks | GUI |
| D37 | Mass local deletion (> 10 or > 5 %) | plan counts | never pushed without GUI confirmation; CLI parks | GUI |
| D38 | Mass incoming deletion | plan counts | never auto-applied; GUI confirmation; CLI parks | GUI |
| D39 | Unknown class/field from the cloud | schema check | park that object | update addon |
| D40 | Object > 200 KB / batch too large | size check, 413 | split; oversize object held | trim the object |
| D41 | `status.json` missing or stale after a CLI run | wrapper compares `run_id` | exit 70 | read the log |
| D42 | Keychain locked / unavailable | `security` exit code | GUI prompt; CLI exit 77 | unlock, rerun |
| D43 | Undo after a sync | (by design) | next sync pushes the reverted values | banner warns before apply |

Cloud:

| ID | Failure | Detection | Behaviour | Recovery |
|---|---|---|---|---|
| S01 | Bad/expired token, wrong aud/client | jose verify | 401 + `WWW-Authenticate` | client re-auth |
| S02 | Not in `gramps-owner`, groups.json unreadable | group resolver | 403, fail closed | fix groups.json |
| S03 | Writes paused / API disabled | `writes_enabled`, env | 503 / 404 | operator flips switch |
| S04 | Handshake mismatch | headers | 426 / 409 | addon update |
| S05 | Invalid op | schema/checker/integrity | 400 / 422 with pointers; nothing written | client fixes |
| S06 | Version, GID or idempotency condition fails | `TransactionCanceledException` reasons | 409 per op / replay | client re-syncs |
| S07 | Seq counter race | condition on `SYNC#HEAD.seq` | re-read and retry ≤ 3 internally | — |
| S08 | DynamoDB throttling/5xx/timeout | SDK errors | retry with jitter within the 15 s budget, else 503 `retryable` (transaction is atomic) | client retries with the same key |
| S09 | Renderer exception | Lambda error | stream retry, bisect, DLQ; `rendered_seq` lags, site stays on the last good render | alarm -> operator re-render |
| S10 | Rendered file fails the privacy re-check | renderer check | file not written, previous version kept, alarm `RenderPrivacyBlock` | fix data via sync |
| S11 | Mass delete in one render | guard | deletes refused, alarm | operator review + override |
| S12 | Push session abandoned | session `ttl`, age > 10 min | render proceeds best-effort, alarm; next desktop run completes or re-pushes | rerun sync |
| S13 | Two live heads with one gramps_id (should be impossible) | renderer | render first by handle order, alarm | operator fix |
| S14 | S3 write denied (policy misconfiguration) | renderer error | manifest not advanced for that key, alarm | fix policy |
| S15 | Head hash mismatch on read | renderer/API | skip object, alarm | operator restores from log |
| S16 | Legacy `aws s3 sync --delete` after cutover | bucket policy | AccessDenied; nothing changes | none |
| S17 | Table restored from PITR (disaster) | client sees `head_seq < last_pull_seq` | desktop refuses (D11) | operator procedure: re-seed from the desktop or accept the restored state (runbook 19.8) |
| S18 | Proposal approved on a stale base | per-object version check | 409 to the proposals domain (mark the proposal `conflict`) | admin re-reviews |

---

## 18. Risks (top)
1. Merge-engine bugs could corrupt io's tree. Mitigations: dry run, verified backup, one transaction with integrity checks, fixture-copy tests, fault injection, shadow runs on DB copies, CLI never resolves conflicts.
2. Text scanners are heuristic; a DOB or address written in prose could slip through. Three layers (desktop exact-DOB + heuristics, server, renderer) narrow it; notes becoming visible (D-02) is reviewed by io in the shadow report.
3. Gramps upgrades (schema 22, new bundled Python, Gtk) stop sync until the addon is updated; the handshake makes it a refusal, not corruption.
4. The bundled Python has no CA bundle; the `/etc/ssl/cert.pem` fallback depends on macOS keeping that file.
5. Running the legacy ETL between seed and the bucket guard would overwrite rendered data; keep the window short and announce it to io.
6. Identity coupling: renumbers and merges break comments/sessions keyed by gramps_id; blocked by default, aliases for merges, identity-domain migration needed.
7. Dropbox placeholders: about half the record media are online-only; blobs stay missing until io makes them available offline.
8. The web-origin pull leg cannot be exercised in prod until the proposals domain writes through `applyBatch()`; covered by e2e meanwhile.
9. Stream/renderer lag leaves the site stale (never wrong); alarms.
10. Generalizing the OAuth server to two clients could regress the MCP client; existing MCP conformance must stay green.
11. Enabling a stream on the production table is an in-place change set on a Retain table; reviewed by change set.
12. Pre-scrub noncurrent S3 versions may still hold day-precise dates until SYNC-13 is executed.

---

## 19. Operator runbook for io

19.1 **Install / update the addon**: `cd ~/harrisonfamily && gramps/scripts/install-addon.sh` (copies `dist/hfy_sync-<ver>` into `~/Library/Application Support/gramps/gramps60/plugins/hfy_sync`); restart Gramps; Tools > Family Tree Processing > Website sync… appears.

19.2 **First time (migration, W5)**: mark the Dropbox media folders "Available offline"; open the tree; Website sync… > Sign in… (passkey); Bind this tree; Check (dry run, review the "To the website" list: everything is a create); Apply (opens a push session, uploads blobs, completes the session). Then the orchestrator runs the shadow render and sends the parity report; approve cutover.

19.3 **Daily**: open Gramps > Website sync… > Check for changes > review > Apply. Or headless with Gramps closed: `hfy-sync check`, then `hfy-sync sync --yes`. Exit codes in 8.7; details in `status.json`.

19.4 **Conflicts and held items**: open the GUI tool; pick per field; held items name the rule and the characters to edit in Gramps.

19.5 **Restore from a backup**: quit Gramps; `mv "<dbdir>/sqlite.db" "<dbdir>/sqlite.db.broken"`; `cp "<backup>.sqlite" "<dbdir>/sqlite.db"`; verify `shasum -a 256` against the `.sha256`; open Gramps; run Check. The cloud is unaffected; the next sync re-pushes whatever the restored tree differs in (review the preview).

19.6 **Upgrading Gramps**: do not upgrade until the addon's release notes list the new version; then upgrade, run `hfy-sync status`.

19.7 **Pause everything**: `api/scripts/sync-admin.mjs pause` (sets `writes_enabled=false`; product-lead credentials) or ask the orchestrator; `resume` reverses. `render --full` re-renders; `render --allow-mass-delete` / `--prune-foreign` after review.

19.8 **Disaster (table restored, or cloud store corrupted)**: pause writes; restore the table from PITR to a new name and swap `TABLE_NAME`; desktop refuses (D11); either accept the restored cloud state (`hfy-sync rebase`, GUI) or re-seed from the desktop (empty store + session push).

19.9 **Lost laptop**: revoke at `/auth/revoke` from another device or delete the refresh-token family (orchestrator); rebind the new Mac with step-up.

19.10 **Never**: run Reorder Gramps IDs in "Change" mode; open the tree with `--force-unlock`; run the retired `sync_to_s3.py` (it refuses; the bucket denies it anyway).

---

## 20. Tasks
See the structured output (keys, waves, dependencies, acceptance criteria). Summary: W0 `d01-scrub-closeout`, `d03-gitignore-guard`; W1 `render-core-port`, `render-defect-fixes`, `redaction-policy-v1`, `privacy-scanner-core`, `gramps-schema-export`, `api-txn-update`, `oauth-desktop-client`; W2 `projection-py`, `merge-engine-py`, `store-apply-core`, `validator-js`, `app-stack-sync-infra`; W3 `sync-routes`, `records-read-api`, `render-lambda`, `addon-skeleton`, `addon-transport-auth`, `sync-dev-harness-e2e`; W4 `addon-pull-apply`, `addon-push`, `addon-media`, `addon-gui-preview`; W5 `seed-and-shadow`, `cutover-live-render`, `first-round-trip-uat`, `sync-docs-runbook`; W6 `changes-feed`, `sync-gramplet`, `sync-admin-status-page`, `merge-alias-redirect`, `tree-svg-ownership`.
