# HFY-PLN-002 design: editing (proposals, Gramps-parity editing, relationship wizard, edit-path privacy guard)

Requirements covered: R-06, R-07, R-08, R-09, R-24, and R-18 inside every edit path (the shared detector itself belongs to the privacy domain). The design emits events for R-10 and R-11, and the notifications domain delivers them.

Inputs read: requirements.md, pln002-intent.md (io's verbatim words win), digest.md, understand.json, the BRD (D-01..D-16, Q-1..Q-5), rulings HFY-R1..R74, hfy-main-read at c712e68, iokit-main-read at 31f6fb3, and the Gramps 6.0.6 bundle. From the bundle I took the editor sources and dumped `get_schema()` plus the type enumerations, which is schema only with no data. I also ran aggregate counts over the read-only copy `pln2/sqlite_copy.db`. No names, dates or contact details appear in this document.

---

## 1. Problem

Today the site is read-only for genealogy. The ETL renders Gramps into S3 JSON, and hfy-api reads `person/<id>.json` only to look up an author label (`api/src/labels.js:13`). io wants three things:

1. **Any signed-in member can propose** a change to any record's metadata, using valid values only (R-06). **Only admins approve** (R-07).
2. **The PWA can edit essentially everything** that Gramps 6.0 edits out of the box (R-08).
3. **Members edit their own information directly**, except DOB, first, middle and last name, and parents, which must be proposals (R-09). Relationships are entered through an interactive, Gramps-like wizard built for older, non-technical members (R-24).

Every submission must pass the contact-info guard (R-18) and the no-DOB-in-cloud rule (R-19).

Constraints the design must respect:

- **D-15 (BRD §11).** Family data is created or edited only by a signed-in principal, with an audit record of principal, time, before and after. PLN-001 kept genealogy editing out of scope and bound "whatever program first opens it". PLN-002 is that program, so nothing is superseded. D-15 now binds record edits.
- **Every API route already requires a session.** Enforced at `api/src/handler.js:80-81`. Writes must be JSON (`:84-95`).
- **Identity is the gramps_id.** The verified session `sub` becomes `actor.id` (`api/src/auth.js:48`), and admin status comes from `config/admins.json` (`auth.js:12-26`, `:48`). That file is currently empty: HFY-R70 and HFY-R73 say it stays empty until io names people.
- **The write helpers are narrow.** The DynamoDB command bag has no UpdateCommand (`api/src/index.js:17`), and `transact()` builds only Put and Delete (`api/src/txn.js:32-38`). The sync domain extends both, and this design consumes that extension (§5.1).
- **The cloud record store, the op API and the S3 projection belong to the sync domain** (R-03, R-04, R-05). Editing never writes S3 or SQLite. It writes only through the sync op API.
- **Gramps semantics are two-sided.** EditFamily keeps both ends of a relationship in step: `parent.add_family_handle` and `child.add_parent_family_handle` (`gramps/gui/editors/editfamily.py:1274-1297`). EditPerson recomputes `birth_ref_index` and `death_ref_index` on save (`editperson.py:968` → `gramps/gen/db/base.py:2025-2047`). A web editor that misses either side corrupts the tree when the desktop next pulls.

Aggregate shape of the tree (read-only copy):

| Object | Count and shape |
| --- | --- |
| People | 231. Gender: 116 female, 112 male, 3 unknown. 60 have no parent family; 171 have one. 2 have two spouse families. |
| Families | 57. 49 have two parents and 8 have a mother only. Type: 39 Unknown, 18 Married. |
| Child links | All frel/mrel are Birth, except 2 Unknown. |
| Events | 169. Dates: 163 year-only, 4 with day precision, 1 empty, 1 "after". 3 events are shared by more than one person. 2 are family events. Person-event roles: 166 Primary, 3 Groom, 2 Bride. |
| Names | 10 alternate names, all left over from merges. 15 "Merged Gramps ID" custom attributes. No other attribute types. |
| Places | 37. None at street level (City 18, State 9, Country 4, Unknown 3, Town 2, Province 1). 33 have an enclosed-by link. None has a code or lat/long. |
| Notes | 6. One has styled-text tags. |
| Media | 32, none with a date. |
| Sources, citations, repositories | 2 sources, 2 citations, 0 repositories. |
| Not present | LDS ordinances, associations, addresses, tags, private flags. |

---

## 2. Design overview

```
member / admin browser                          hfy-api (Lambda, /api/*)                               sync domain
┌──────────────────────────┐   POST /api/changes   ┌─────────────────────────────────────────┐   records.apply()   ┌──────────────────┐
│ editor island (/edit/)   │ ─────────────────────▶│ field-policy → ops engine → semantics   │────────────────────▶│ REC# store (ver) │
│ wizard island (/edit/    │   POST /api/relation- │ → guard (R-18/R-19) → partition:        │  If-Match versions  │ CHANGE# log      │
│   family/)               │   ships(/preview)     │   direct groups ──────────────────────┐ │  + extra items      │ AUDIT# per object│
│ review island            │──────────────────────▶│   review groups → PROP# proposal      │ │  (one TransactWrite)│ S3 projection    │
│   (/me/review/)          │   /api/proposals/*    │ decision: rebase → apply → audit      ─┘ │                     │ desktop pull     │
└──────────────────────────┘◀──────────────────────│ notifier producers (R-10/R-11 events)   │                     └──────────────────┘
        ▲ @io-kit/schema_form forms               └─────────────────────────────────────────┘
        ▲ @io-kit/gates useGateInbox + renderCard
```

One pipeline serves every edit path:

1. **Field policy** decides, for each change, whether this viewer may save it now, must send it for review, can only have an admin make it, or may never make it.
2. **The ops engine** applies field-level diff ops to the current redacted Gramps JSON. It also inverts them for undo and rebases them three ways for stale proposals.
3. **Gramps semantics** keeps derived fields and two-sided links, validates dates, and compiles relationship intents.
4. **The guard** runs the shared R-18/R-19 detectors over the result.
5. **Partition** splits the changes into dependency-closed groups. Groups the viewer may save directly are written through the sync op API. The rest become one proposal.

The approval queue reuses the `@io-kit/gates` contract (§7.4).

---

## 3. Gramps 6.0 editing inventory and field policy

### 3.1 Policy codes

| Code | Meaning | Who |
| --- | --- | --- |
| **D** | Saves directly | The member on their own record. Admins on any record. |
| **P** | Proposal only | Members. Admins save directly. |
| **A** | Admin only on the web | Members cannot even propose it. |
| **desk** | Not editable on the web | io does it in Gramps desktop, and it syncs up. |
| **N** | Never in the cloud | Refused on every path, admins included, at the guard and again in the sync validator. Gramps desktop keeps it. |
| **RO** | Read-only or derived | Computed by the server, never accepted from a client. |
| **→dom** | Owned by another domain's surface, which uses this pipeline | links: R-16/17. tagging: R-29..31. photos: R-01/02. |

**"Own record" scope** (resolution in §4):

- the member's own `Person` object;
- the secondary objects embedded in it;
- any primary `Event` or `Note` referenced **only** by that Person, with role Primary for events.

Anything shared counts as someone else's record. Families, multi-person events, places, sources, citations, repositories and media objects are all shared, even when reached from the member's own page.

R-24 calls relationships "relationship proposals", so spouse and children are proposals too. That matches R-09's "parents" exception.

### 3.2 Inventory: every Gramps 6.0.6 editor, tab and field

Editor paths are under `gramps/gui/editors/` in the Gramps.app bundle. Field paths are Gramps JSON (schema v21) as dumped from `get_schema()`.

The three policy columns are:

- **Own**: a member editing their own record.
- **Other**: a member editing anyone else's record.
- **Admin (web)**: an admin editing any record.

**Edit Person** (`editperson.py`; preferred-name block, tabs at `:507-623`; Name editor `editname.py:127-321`)

| Tab / field | Gramps JSON | Own | Other | Admin (web) | Notes |
|---|---|---|---|---|---|
| Given name(s) | `primary_name.first_name` | **P** | P | D | R-09 "first, middle". One string holds first and middle (gap fill: 70 of 231 primary names store a middle name inside it). The form shows read-only First/Middle labels and never writes two fields. |
| Surname(s) | `primary_name.surname_list[].surname`, plus `prefix`, `connector`, `origintype`, `primary` (SurnameTab) | **P** | P | D | R-09 "last". Labelled "last name at birth (maiden)"; every surname in the tree is the birth surname. |
| Title | `primary_name.title` | D | P | D | |
| Suffix | `primary_name.suffix` | D | P | D | R-09 lists only first, middle and last (DEC-E3). |
| Call name ("name you go by") | `primary_name.call` | D | P | D | Hard check: it must be one of the first_name tokens. Gramps only colours the field red. |
| Nickname | `primary_name.nick` | D | P | D | |
| Family nickname | `primary_name.famnick` | D | P | D | |
| Name type | `primary_name.type` (NameType) | **P** | P | D | Changing the type changes what the name means. |
| Name date | `primary_name.date` | P | P | D | |
| Group / sort / display as | `group_as`, `sort_as`, `display_as` | desk | desk | desk | Display configuration; unused in the tree. |
| Name citations / notes | `primary_name.citation_list`, `.note_list` | P / D | P | D | Citations are shared objects. Notes that only this person uses are own. |
| Gender | `gender` (0 female, 1 male, 2 unknown, 3 other) | D | P | D | Not in R-09's exceptions. The UI warns that family slots are unchanged (DEC-E3). |
| Gramps ID | `gramps_id` | desk | desk | desk | Identity key: session sub, S3 key and allowlist value. |
| Tags | `tag_list` | A | A | D | Admins may only assign tags that already exist. |
| Private | `private` | desk | desk | desk | The sync domain's policy decides how private objects are handled. |
| Events tab | `event_ref_list[]` and the Event objects | D (own-only events) | P | D | See Edit Event. On the member's own record these are P: Birth date (year only, DEC-E4), changing an event's type to or from Birth/Death, and Death, Burial, Cremation, Probate, Will and Cause of Death. |
| Names tab (alternate names) | `alternate_names[]` | P (add, remove, first_name, surname, type) / D (nick, call, title, suffix) | P | D | The 10 merge leftovers display as "also recorded as". |
| Citations tab | `citation_list[]` | P | P | D | Shared objects. |
| Attributes tab | `attribute_list[]` (AttributeType, 17 values) | D | P | D | Social Security Number (6) and Identification Number (3) are **N**. The "Merged Gramps ID" custom attribute is **desk**. Members choose only standard types or custom strings that already exist (DEC-E10). |
| Addresses tab | `address_list[]` (street, locality, city, county, state, country, postal, phone) | **N** | **N** | **N** | R-18 contact info. |
| Notes tab | `note_list[]` and Note objects | D (own-only notes) | P | D | See Edit Note. |
| Gallery tab | `media_list[]` (MediaRef: ref, rect, attributes, notes, citations) | D (reorder, remove, primary photo = first) | P | D | `rect` goes to tagging (R-31; own D, other P). A new Media object goes to photos (R-02 graduation, admin). |
| Internet tab | `urls[]` (UrlType) | →links (D, the 7 link kinds) | P | D | Type E-mail (1) is **N**. Other types are desk. |
| Associations tab | `person_ref_list[]` (PersonRef: ref, rel, citations, notes) | D | P | D | Stored only on the owner's Person. None in the tree. |
| LDS tab (shown only when LDS data exists) | `lds_ord_list[]` | desk | desk | desk | None in the tree. |
| References tab | backrefs | RO | RO | RO | |
| Derived | `birth_ref_index`, `death_ref_index`, `family_list`, `parent_family_list`, `change` | RO | RO | RO | The server recomputes the index fields with Gramps' rule (`gen/db/base.py:2025-2047`). The two lists are written only by relationship ops. |

**Edit Family** (`editfamily.py`; tabs at `:804-873`; glade labels "Father/partner1" and "Mother/partner2")

| Tab / field | Gramps JSON | Own (member is a spouse or child) | Other | Admin | Notes |
|---|---|---|---|---|---|
| Father/partner1, Mother/partner2 | `father_handle`, `mother_handle` | **P** (wizard) | P | D | Removing a parent needs a fresh sign-in at approval (DEC-E9). |
| Relationship type | `type` (FamilyRelType: Married, Unmarried, Civil Union, Unknown, Custom) | P | P | D | |
| Children tab | `child_ref_list[]` (ChildRef: ref, frel, mrel, order; citations and notes per `editchildref.py:172-190`) | **P** | P | D | R-09 parents and the R-24 wizard. |
| Events tab | `event_ref_list[]` (Marriage, Divorce, Engagement and other family events) | P | P | D | New marriage events go on the family with role Family (8), not on the persons. |
| Citations, Attributes, Notes, Gallery tabs | lists | P | P | D | |
| LDS tab | `lds_ord_list[]` | desk | desk | desk | |
| Gramps ID, Tags, Private | | desk / A / desk | | | |

**Edit Event / Event Reference** (`editevent.py:216-261`, `editeventref.py:221-305`, `editdate.py`)

| Field | Gramps JSON | Own-only event | Shared or other | Admin | Notes |
|---|---|---|---|---|---|
| Type | `type` (EventType, 47 values) | D (P if the change is to or from Birth/Death) | P | D | |
| Date | `date` {calendar, modifier, quality, dateval, text, newyear}; `sortval` RO | D (non-birth) | P | D | Birth: year-only on every path (**N** for day and month). Text-only dates are scanned. Gregorian and Julian are allowed; other calendars are desk. |
| Place | `place` (handle) | D (existing place) | P | D | A new place makes the group P (§6.3). |
| Description | `description` | D | P | D | Guarded. |
| Citations, Notes, Gallery, Attributes tabs | lists | P / D / D / D | P | D | |
| Role (EventRef) | `event_ref_list[].role` (EventRoleType, 20 values) | D (P for Primary on Birth or Death) | P | D | |
| EventRef attributes, notes, citations | ref-level lists | D / D / P | P | D | |
| Gramps ID, Tags, Private | | desk / A / desk | | | |

**Edit Place** (`editplace.py:298-380`, `editplaceref.py`, `editplacename.py`, `editlocation.py`)

| Field | Gramps JSON | Member | Admin | Notes |
|---|---|---|---|---|
| Name (value, lang, date) | `name` | P | D | Places are always shared. |
| Type | `place_type` (PlaceType, 22 values) | P | D | Street (7), Building (19) and Number (20) are **N** (DEC-E12). |
| Code | `code` | A | D | Can hold a postal code. None in the tree. |
| Latitude / longitude | `lat`, `long` | P | D | Decimal degrees within range. None in the tree, so this helps R-22. |
| Enclosed by | `placeref_list[]` {ref, date} | P | D | |
| Alternative names | `alt_names[]` | P | D | |
| Locations tab (conditional) | `alt_loc[]` (Location has street, postal, phone) | **N** | **N** | |
| Citations, Notes, Gallery, Internet | lists | P | D | Internet type E-mail is **N**. |
| Title (legacy) | `title` | desk | desk | Gramps 6 generates the display title. |

**Edit Source** (`editsource.py:179-227`, `editreporef.py:163-216`): title, author, pubinfo, abbrev, notes, gallery and attributes (SrcAttribute) are **P** for members and **D** for admins. The Repositories tab (RepoRef: ref, call_number, media_type, notes) is also **P** for members and **D** for admins. Gramps ID, Tags and Private follow the Person rules.

**Edit Citation** (`editcitation.py:268-306`): source (handle), page, date, confidence (0-4) and the notes, gallery and attributes tabs are **P** for members and **D** for admins.

**Edit Repository** (`editrepository.py:139-178`): name and type (RepositoryType) are **P** for members and **D** for admins. The Addresses tab is **N**. The Internet tab is **P** for members and **D** for admins, except type E-mail, which is **N**. Notes are **P** for members and **D** for admins.

**Edit Media / Media Reference** (`editmedia.py:230-269`, `editmediaref.py:497-570`):

- description and date are **P** for members and **D** for admins. No media object has a date yet, which matters for on-this-day (R-14).
- path, mime and checksum are **A**, through the photos domain's graduation (R-02). Local absolute paths never reach the cloud.
- the citations, attributes and notes tabs are **P** for members and **D** for admins.
- MediaRef `rect` belongs to tagging (→tagging).

**Edit Note** (`editnote.py:209-287`): text (StyledText `string` + `tags`), format and type (NoteType, 29 values) are **D** when the note is used only by the member's own record and **P** otherwise. Styled-tag handling is in DEC-E11.

**Not record editors, or desk by choice (DEC-E8):**

- Organize Tags (`edittaglist.py`), merges of every class, Reorder Gramps IDs, Check and Repair, Sort Events, and deleting Person, Family, Place, Source, Repository or Media objects.
- Researcher (Preferences) is **N**, because it holds contact details.
- Members can still propose *removals*:
  - remove an event, note or citation from a page (removes the ref, and deletes the object only if nothing else uses it);
  - unlink a parent, child or spouse.

  Admins approve removals with a fresh sign-in.

### 3.3 Field-policy table (machine form)

The table lives in `api/src/records/field-policy.js`, next to `POLICY_ROWS` (`api/src/policy.js:28-35`). The client reads a copy through the edit bundle (§7.2). Each row is:

```js
// [class, pointerPattern, own, other]   admin: "direct" unless the row says "admin" | "desk" | "never" | "derived"
// pointerPattern: RFC 6901 with "*" = any list element, "**" = any subtree. Most specific wins. Unmatched => "admin" (fail closed).
["Person", "/primary_name/first_name",                "proposal", "proposal"],
["Person", "/primary_name/surname_list/**",           "proposal", "proposal"],
["Person", "/primary_name/type",                      "proposal", "proposal"],
["Person", "/primary_name/{title,suffix,call,nick,famnick}", "direct", "proposal"],
["Person", "/alternate_names/*",                      "proposal", "proposal"],   // add/remove
["Person", "/alternate_names/*/{title,suffix,call,nick,famnick}", "direct", "proposal"],
["Person", "/gender",                                 "direct",   "proposal"],
["Person", "/parent_family_list/**",                  "proposal", "proposal"],   // R-09 parents
["Person", "/family_list/**",                         "proposal", "proposal"],   // R-24 spouse
["Person", "/address_list/**",                        "never",    "never"],
["Person", "/attribute_list/*[type=3|6]",             "never",    "never"],
["Person", "/urls/*[type=1]",                         "never",    "never"],
["Person", "/{gramps_id,private,lds_ord_list/**}",    "desk",     "desk"],
["Person", "/{birth_ref_index,death_ref_index,change}", "derived", "derived"],
["Event",  "/date/dateval/{0,1}?birth",               "never",    "never"],     // day and month of a Birth date
["Family", "/**",                                     "proposal", "proposal"],
["Place",  "/place_type?{7,19,20}",                   "never",    "never"],
["Place",  "/alt_loc/**",                             "never",    "never"],
// … one row per inventory line in §3.2; a unit test asserts every pointer in the generated record schemas matches a row.
```

**Partition rule (DEC-E6).** The ops in one submission are grouped into dependency-closed groups. Ops that reference the same `new:n` temp object, or the two sides of one link, fall in the same group. A group is direct only if every op in it is direct for this viewer. Direct groups commit now; the other groups become one proposal. The UI shows the split before the member confirms (§9.1).

---

## 4. Resolving the member's own record

```
ownRecord(actor):
  gid = actor.id                       // verified session sub = gramps_id (auth.js:48); never from the request body, never by name or email
  hits = records.byGrampsId("Person", gid)        // sync-domain accessor; gramps_id is NOT unique in Gramps (dbapi.py:232)
  hits.length === 1  → { cls:"Person", handle: hits[0].handle, gramps_id: gid }
  otherwise          → null, logged as own_record_missing | own_record_ambiguous (counts only, no ids in the logs)

relationOf(actor, key):
  key === Person:<own handle>                                   → "own"
  key is an Event referenced only by the own Person, role Primary → "own"   (the store's reference index answers this)
  key is a Note referenced only by the own Person or own-only events → "own"
  otherwise                                                     → "other"
```

- **Fail closed.** With no own record (null), every change becomes a proposal. The editor says: "we couldn't match your account to your page, so your changes will go to an admin."
- **Renumbering.** If io renumbers IDs, the sessions fail closed with `principal_changed` (identity-model.md). Proposals keep the handle as their key, so they survive.
- **The client mirror is cosmetic.** The browser repeats the check for UI labels only: `family-route.js:5,9` and `my-posts.jsx:74,91` already use the session sub this way. The server decides.
- **No delegation in v1 (DEC-E14).** A parent editing a minor's page, or a caretaker editing an elder's page, goes through proposals.

---

## 5. Data model

### 5.1 Consumed from the sync domain (contract; their task keys are `sync-cloud-store` and `sync-op-api`)

```
REC#<Class>#<handle>  / META   { obj: <redacted Gramps JSON v21, _class-tagged>, version: int (monotonic), hash, gramps_id, updated_at, origin }
records.get(cls, handle) → { obj, version } | null
records.byGrampsId(cls, gid) → [{ handle, version }]
records.backrefs(key) → [key]                        // reference index, used for "own-only" and orphan checks
records.graph() → { families: {h:{father,mother,children[]}}, parents: {personH:[familyH]} }   // cached ≤60 s, used for cycle checks
records.customTypes() → { EventType:[str], AttributeType:[str], … }                         // registry of the tree's custom strings
records.apply({ ops: [{ kind: "put"|"delete", cls, handle, base_version|null, obj }],
                actor, origin: { kind: "self"|"admin"|"proposal", proposalId?, proposer?, approver? },
                idempotencyKey, extra: TransactItem[] })   // extra items ride in the SAME TransactWriteItems
  → { versions: { "<Class>:<handle>": int }, seq }
  throws VersionConflict{ key, current } | RedactionViolation{ errors[] } | Unavailable
```

Editing sends **whole new objects**, guarded by `base_version`, which is the ARCH-B op shape. `records.apply` writes the CHANGE# log entry and the per-object `AUDIT#<Class>:<handle>` item (D-15), and runs the R-19 redaction validator on every write as a second line of defence. Field-level diffing and rebasing stay in this domain.

`txn.js` must gain ConditionCheck and Update support (today it has only Put/Delete, `txn.js:32-38`), and so must the fake DDB (`api/test/fake-ddb.js:65-82`). That work belongs to `sync-op-api`.

### 5.2 Items this domain adds (table `hfy-app`, single GSI1)

| Item | PK | SK | GSI1PK | GSI1SK | Attributes |
|---|---|---|---|---|---|
| Proposal | `PROP#<ulid>` | `META` | `PROPQ#<state>` | `<ulid>` | `entity:"proposal"`, `proposal:{…}` |
| By-proposer index | `PROP#<ulid>` | `IDX#BY` | `PROPBY#<principal>` | `<ulid>` | full proposal copy |
| Per-record index (one per target object) | `PROP#<ulid>` | `IDX#REC#<Class>:<handle>` | `PROPREC#<Class>:<handle>` | `<ulid>` | full proposal copy |
| Idempotency | `IDEM#<principal>#<sha256(key)>` | `META` | – | – | `requestHash`, `result`, `ttl` = now + 24 h |
| Proposal audit (D-15) | `AUDIT#proposal:<ulid>` | `<iso>#<ulid>` | `AUDIT` | `<iso>#<ulid>` | built by `auditItem` (`txn.js:5-20`). Ops: `proposal.create`, `.amend`, `.withdraw`, `.decide`, `.stale`, `.supersede` |
| Proposal comments | `THREAD#proposal:<ulid>` | `C#<ulid>` | `COMMENTS` | `<ulid>` | the existing comment layout (`comments.js:1-3`) |

This copies the post layout: a main item plus IDX items that each carry the full document, so a list read needs no second fetch (`content.js:90-99`).

- **State changes.** A state change rewrites META, so its GSI1PK `PROPQ#<state>` moves the item between queues. It also rewrites every IDX copy, in the same transaction as the decision.
- **Size caps.** At most 64 KB serialized, at most 50 ops, at most 10 new objects, and at most 10 children per relationship proposal. With these caps a decision transaction stays under 40 items (100-item limit).
- **Rate limit.** At most 50 proposals per principal per 24 h, counted by querying `PROPBY#<principal>` with `GSI1SK > ulid(now-24h)`. No counter item is needed.

**Proposal document**

```jsonc
{
  "id": "<ulid>", "rev": 1,
  "state": "pending | needs_changes | stale | approved | rejected | withdrawn | superseded",
  "kind": "edit | relationship | create",
  "proposer": { "id": "<gramps_id>", "label": "<displayName, never an email (HFY-R68)>" },
  "origin": "web | mcp",
  "subject": { "cls": "Person", "handle": "<h>", "gramps_id": "<id>" },     // the page it is "about"
  "targets": ["Person:<h>", "Family:<h>"],
  "base_versions": { "Person:<h>": 12, "Family:<h>": 3 },
  "ops": [ /* EditOp[] (§5.3) */ ],
  "intent": { /* RelationshipIntent (§8.2), relationship proposals only */ },
  "summary": [ { "text": "change nickname from “A” to “B”", "opIds": ["o1"] } ],   // server-rendered, plain language
  "note": "optional message to the admin (≤1000 chars, guarded)",
  "warnings": [ { "code": "possible_duplicate", "detail": "…" } ],
  "created_at": "…", "updated_at": "…",
  "decision": { "verdict": "approve|deny|needs_changes", "by": {"id","label"}, "at": "…", "reason": "…",
                "amended": false, "applied": { "Person:<h>": 13 }, "auth_time": 0 },
  "etag": "<sha256 hex of canonical {id, rev, state, base_versions, ops}>"
}
```

### 5.3 EditOp language (the diff format)

```jsonc
{ "id": "o1",
  "op":  "set | add | remove | move | create | delete",
  "obj": "Person:<handle> | new:1",
  "cls": "Person",                       // create only
  "path": "/primary_name/nick",          // RFC 6901 into the object
  "base": "<JSON value at base_version>",// required for set, remove and delete (as a content hash for delete)
  "value": "<new JSON value>",           // set, add, create
  "before": "<key segment>"              // add or move position (absent = append)
}
```

- **Addressing list elements by key, never by index.** Gramps lists have no ids, and users reorder them.
  - Ref lists: `@ref=<handle>` for `event_ref_list`, `child_ref_list`, `media_list` and `placeref_list`.
  - String lists: `@=<handle>` for `family_list`, `parent_family_list`, `note_list` and `citation_list`.
  - Other secondary lists: `@k=<first 12 hex of sha256(canonical element at base)>` for `alternate_names`, `attribute_list`, `urls`, `surname_list` and `alt_names`. This follows the gap fill: "use the name's prior value, not list position".
- **Temp handles.** `new:n` objects get real handles at commit, minted like Gramps' `create_id()` (`gramps/gen/utils/id.py`): `"%08x%08x" % (int(time*10000), rand63)`, lowercase hex.
- **gramps_id.** New objects get one under the sync domain's ID policy. The gap fill's option (a), desktop mints, is the default (DEC-E13).
- **Enum values.** Typed values use the Gramps JSON form `{"_class":"EventType","value":12,"string":""}`. Custom values use `{"value":0,"string":"<existing custom string>"}`.

---

## 6. Validation: valid values only

### 6.1 Record schemas (server and client)

`scripts/records/gen-edit-schemas.py` runs under the Gramps bundle shim on io's Mac, with the same environment used for `pln2/alive/run_alive.py`. It reads **only** `get_schema()` and the `_DATAMAP` type tables; it reads no tree data. It emits `api/src/records/schemas/<class>.schema.json` (JSON Schema 2020-12) for Person, Family, Event, Place, Source, Citation, Repository, Media and Note, with the secondary objects in `$defs`.

- **Enums.** Each Gramps type becomes `oneOf` over `{value: const}` with plain-language `title`s (EventType 47, PlaceType 22, NoteType 29, AttributeType 17, EventRoleType 20, ChildRefType 8, FamilyRelType 5, NameType 5, UrlType 6, RepositoryType 11, SourceMediaType 15, NameOriginType 14, SrcAttributeType 2). A `value: 0` (Custom) branch accepts `string` only when it is in `records.customTypes()`. The server enforces this by injecting the enum at runtime (DEC-E10).
- **Never fields are dropped.** `address_list`, `alt_loc`, Location street/postal/phone, the Researcher record, Url type E-mail and LDS do not exist in the schema, so `additionalProperties:false` rejects them structurally.
- **Strings.** Bounded lengths: name parts 100, description 500, note 10,000, page 500, titles 200. Strings are NFC-normalized, contain no control characters, and are trimmed. Name parts are `^[\p{L}\p{M} .'’-]+$`, so they hold no digits and cannot carry a phone number.
- **Dates.** Validation that JSON Schema cannot express runs in code (§6.2). The schema pins the shape of `dateval` per modifier.
- **Drift check.** Every output carries a sha256 header. `--check` fails on drift, and a test asserts that every schema pointer matches a field-policy row.

The browser renders **form schemas**: small, hand-authored view models per section in `islands/src/lib/edit-forms/*.js`, which reference the generated enums. `@io-kit/schema_form` renders them. Its valid-values-only behaviour comes from the kit: enum becomes radio or select, a oneOf of consts becomes `titledSelect`, and `x-io-ref` with `allowFreeText:false` refuses ids the search did not return (`walker.ts:49-82`; README "Host contract"). Adapters map view model ↔ EditOps.

### 6.2 Semantic validators (`api/src/records/semantics.js`)

- **Dates.** Gregorian and Julian only for members. The day must fit the month. Years run 1000 to the current year, with no future dates. A range or span must start before it ends. `sortval` is computed server-side (Gregorian SDN; year-only maps to January 1, matching the live data) and never accepted from a client. `text` must be empty unless the modifier is TEXTONLY.
- **References.** Every handle must exist (`records.get`) with the right class, or be a `new:n` created in the same submission.
- **Two-sided links** (EditFamily parity, `editfamily.py:1274-1297`). After the ops apply:
  - `F.father/mother = p` holds exactly when `p.family_list` contains F;
  - a ChildRef for c in F exists exactly when `c.parent_family_list` contains F.
- **Family sanity** (`editfamily.py:1223-1240` parity). No person is both a parent and a child of the same family, father differs from mother, and no ChildRef appears twice.
- **No ancestry cycles.** Depth-first search over `records.graph()`.
- **Derived fields.** `birth_ref_index` and `death_ref_index` are recomputed for every Person whose `event_ref_list` changed, and for every Person that references an Event whose type changed. This follows the `set_birth_death_index` rule (`gen/db/base.py:2025-2047`).
- **Call name** must be one of the first_name tokens.
- **Warnings** do not block; they are shown to the admin. Examples: "already has birth parents recorded", "parent born fewer than 13 years before child" (Gramps' `min-generation-years` default), and "possible duplicate person".

### 6.3 The guard in every edit path (R-18, plus R-19 precision)

`api/src/records/guard.js` adapts the privacy domain's shared detector (task `privacy-guard-module`). It assumes this interface:

```
scanContact(text) → [{ kind: "phone"|"address"|"email", start, end }]
scanDob(text, { living }) → [{ start, end }]
```

The guard runs on **the resulting objects, not the request text**. It covers every string leaf: note text, descriptions, attribute values, name parts, place names, source and citation text, media description and URL description. It also runs on proposal notes, decision reasons, comments on proposal threads, and the stub fields in relationship intents. Its structural rules:

- **Birth dates** (EventType 12): `dateval` day and month must be 0 on every path, for living and deceased people alike (io's words: "we also don't store DOBs on cloud").
- **Baptism, Christening and Adult Christening** (15, 22, 14) are treated the same way for people classed as living (DEC-E12).
- **TEXTONLY dates** on those event types run through `scanDob`.
- **Never fields and values**:
  - Place types 7, 19 and 20;
  - Url type 1;
  - Attribute types 3 and 6;
  - any `address_list` or `alt_loc` content.

  All are refused with `never_in_cloud`, which normally cannot happen because the schema lacks them.

**The edit paths and where each is guarded:**

| # | Path | Guard point |
|---|---|---|
| a | `POST /api/changes` (direct and proposal) | Before partitioning, over every resulting object |
| b | `PATCH /api/proposals/:id` (amend) | Same |
| c | `POST /api/proposals/:id/decision` with `amend` (admins are not exempt) | Same |
| d | `POST /api/relationships(/preview)` | Stub names, place names, years, note |
| e | Comments on `proposal:<id>` threads | The `comments.js` create/edit path for that subject |
| f | Approval-time re-check | The rules may have tightened since submission. A failure moves the proposal to `needs_changes` with a system reason. |
| g | MCP tools | The same handlers, through `handler.invoke` (`handler.js:64-68`) |
| h | Client mirror in the editor, wizard and review islands | Same detector, bundled. Gives inline highlighting and disables submit. UX only. |
| i | `records.apply` | The sync domain's R-19 validator, as defence in depth |

**Errors** are `422` with `errors:[{opId, obj, path, pointer, code: "contact_info"|"dob_not_allowed"|"never_in_cloud", kind, span:[start,end]}]`. The matched text is **never echoed** and **never logged**; logs carry only counts per code. User-facing copy follows the DS voice: "this looks like a phone number or street address. we don't keep those on the site — please remove it to continue." There is no override; the error stays until the user removes the text (R-18).

---

## 7. APIs

All routes go in `ROUTES` (`api/src/routes.js:61-129`) and inherit `auth:"session"`, the 415 JSON rule and `no-store` (`handler.js:84-99`).

**Server switch.** `HFY_EDITING=on` (a CloudFormation parameter, default off). While it is off the new routes return 404 `not_found`, so writes cannot be reached by curl before the flip (DEC-E15).

**Error shape.** Errors keep the existing `{error, message, details}` shape (`http.js:24-32`) and add an `errors[]` array whose items carry `pointer` and `detail`. That makes the response a valid `Problem` for schema_form's `mapServerProblem` (`schema_form/src/types.ts:155-161`, `validate.ts:56-81`).

### 7.1 `GET /api/me`

Returns 200:

```json
{ "id": "<gramps_id>", "label": "…", "admin": true, "ownRecord": { "cls": "Person", "handle": "…", "gramps_id": "…" }, "editing": true }
```

`ownRecord` is null when unresolved. This exposes `actor.admin` to the client reliably (digest: "no role or admin flag reaches the client"). The moderation domain (R-32) shares this route; whichever domain lands first owns it.

### 7.2 `GET /api/edit/:cls/:ref` (the edit bundle)

`ref` is a gramps_id or `h:<handle>`. Returns 200:

```jsonc
{ "key": "Person:<h>", "version": 12, "etag": "Person:<h>@12", "obj": { /* redacted Gramps JSON */ },
  "related": { "Event:<h>": { "version": 4, "obj": {…} }, "Place:<h>": {…}, "Note:<h>": {…}, "Family:<h>": {…},
               "Person:<h2>": { "version": 7, "stub": { "displayName": "…", "gender": 1, "isLiving": true, "lifespan": "…" } } },
  "relation": "own | other", "viewer": { "admin": false },
  "policy": { "/primary_name/first_name": "proposal", "/primary_name/nick": "direct", "/gramps_id": "desk", … },
  "pending": [ { "proposalId": "…", "state": "pending", "paths": ["/primary_name/first_name"] } ],
  "customTypes": { "EventType": ["…"] }, "schemaHash": "<sha256>" }
```

| Status | Error | When |
|---|---|---|
| 404 | `not_found` | The record does not exist or editing is off |
| 409 | `ambiguous_id` | A gramps_id maps to more than one object; `candidates:[handle]` lists them |

### 7.3 `POST /api/changes`

Requires the `Idempotency-Key` header unless `dry_run`.

**Request**

```jsonc
{ "target": "Person:<h>", "base_versions": { "Person:<h>": 12, "Event:<h>": 4 }, "ops": [EditOp…],
  "note": "optional", "route": "auto | review", "dry_run": false }
```

Admins may send `route:"review"` to queue their own change. Members always get `auto`.

**Responses**

- **200 dry_run:** `{ plan: { direct:[{opIds, summary[]}], review:[{opIds, summary[]}] }, warnings[], errors[] }`. The confirmation screen and MCP `agentMode: dry_run` use this.
- **201:** `{ applied: { versions, undo: { base_versions, ops } } | null, proposal: ProposalView | null, summary[] }`.

**Atomicity.** The direct groups and the proposal items (plus the `IDEM#` item) go in **one** `records.apply(... extra)` transaction, so a submission is all or nothing. `undo` holds the inverse ops against the new versions. The client offers it for 10 minutes; replaying it is an ordinary audited change.

| Status | Error | When |
|---|---|---|
| 400 | `validation` | `errors[]` with pointers |
| 403 | `not_allowed` | An op touches an `admin`, `desk` or `never` path for this viewer; `errors[]` lists the paths |
| 409 | `version_conflict` | A direct group's base is stale; the body has `current: {key: version}`, and the client refetches the bundle and replays |
| 413 | `too_large` | Over the size caps |
| 422 | `contact_info`, `dob_not_allowed`, `never_in_cloud`, `idempotency_mismatch` | §6.3; same key with a different body |
| 429 | `rate_limited` | Over the proposal rate limit |
| 503 | `unavailable` | The store is down |

### 7.4 Proposals and the approval queue (reuses @io-kit/gates; DEC-E1)

| Route | Who | Request → response |
|---|---|---|
| `GET /api/proposals?view=queue\|mine\|about-me&state=&cursor=&limit=` | queue: admin (else 403). mine: proposer. about-me: proposals whose targets include the caller's own Person or Families | `{items: ProposalView[], cursor}`, oldest first for the queue |
| `GET /api/proposals/:id` | proposer, admins, owners of targeted pages (else 404) | `ProposalView & { rebase: { status: "current"\|"clean"\|"conflict", conflicts:[{opId, obj, path, base, current, proposed}] } }` |
| `PATCH /api/proposals/:id` (If-Match: etag) | proposer; state pending, needs_changes or stale | `{ops, base_versions, note?}` → ProposalView with `rev+1` and state pending. 412 `precondition_failed` returns the fresh view. 409 `not_amendable`. |
| `POST /api/proposals/:id/withdraw` (If-Match) | proposer | → state withdrawn |
| `POST /api/proposals/:id/decision` (If-Match, Idempotency-Key) | `actor.admin` only | `{verdict:"approve"\|"deny"\|"needs_changes", reason?, amend?:{ops, base_versions}}` → `{proposal, applied?: {versions}}` |
| Comments | proposer, admins, page owners | the existing `/api/comments` with `subject=proposal:<ulid>` |

`ProposalView` is the proposal plus `can:{amend, withdraw, decide, comment}` and `stale: boolean`. Staleness is computed on read by comparing `base_versions` with the current versions.

**Decision rules:**

- **deny and needs_changes** require a `reason`, which is guarded. This matches gates `assertDecideRequest`, where deny requires a reason (`gates/src/client.ts:53-59`).
- **Destructive approvals** need `auth_time ≤ 900 s`. A proposal is destructive if it removes a parent, child or spouse link, or deletes an object. Otherwise the server answers 401 `step_up_required {maxAgeSeconds:900}`, and the client goes to `/auth/login?prompt=login&returnTo=` (HFY-R64 honours `max_age` and `prompt=login`). DEC-E9.
- **Errors:**

  | Status | Error | When |
  |---|---|---|
  | 403 | `not_admin` | The caller is not an admin |
  | 412 | `precondition_failed` | Another admin acted, or the proposal was amended; the body carries the fresh view, which gates' `cardFromConflict` re-renders |
  | 409 | `rebase_conflict` | The record changed underneath; the proposal is now `stale` |
  | 422 | guard codes | Approval-time guard failure (§6.3 f) |
  | 409 | `invalid_state` | The proposal is in a state that cannot be decided |

**What approve does.** One request, one transaction:

1. Authenticate the caller and require `actor.admin`. Load the proposal. Check the etag (412). Check `state ∈ {pending, stale}`. Check the step-up rule when the proposal is destructive.
2. If `amend` is present, apply it, validate it, guard it, and record `decision.amended = true`.
3. Load the current objects for the targets and rebase (§7.5). On a conflict:
   - persist `state = stale` with an audit `proposal.stale`;
   - notify the proposer (`proposal_stale`);
   - return 409.
4. Mint handles for `new:n`. Build the whole new objects. Recompute derived fields and run the semantic validators again. Run the guard again.
5. `records.apply({ ops: puts and deletes guarded by current versions, origin: {kind:"proposal", proposalId, proposer, approver}, idempotencyKey: "prop:<id>:<rev>", extra: [...] })`. The `extra` items are:
   - the proposal META, with ConditionCheck `rev = :rev AND state IN (pending, stale)`;
   - every IDX# copy, moved to `state = approved` with `decision.applied` set;
   - `AUDIT#proposal:<id>`, op `proposal.decide`.

   The sync domain adds the CHANGE# entries and the per-object AUDIT# items in the same TransactWriteItems.
6. After commit, the producers run (never failing the write, as with `handler.js:15-21`):
   - `proposal_accepted` to the proposer (R-11);
   - `record_updated` to each member whose own Person is among the targets and who is not the proposer (R-11);
   - the record-change event to subscribers (R-12, emitted by `records.apply`'s hook, which the notifications domain owns).

   Contributions (R-25/26) credit the **proposer** through `origin.proposer`.

**deny and needs_changes** run one transaction: META, the IDX copies and the audit. Afterwards the producers send `proposal_rejected` or `proposal_needs_changes` to the proposer, with the reason in-app at level 1 only.

**Submission** notifies admins with `proposal_submitted` (R-10).

**Template registry additions** (`api/src/notify.js:5-15`; mirrored by hand in `islands/src/islands/notifications.jsx` CATALOG). DS voice: lowercase, "page" never "record".

| Type | Level 0 | Level 1 |
|---|---|---|
| `proposal_submitted` | "there's a suggested change to review." | "{actor} suggested a change to review." |
| `proposal_accepted` | "your suggested change was added." | "{actor} added your suggested change." |
| `proposal_needs_changes` | "an admin has a question about your suggestion." | |
| `proposal_rejected` | "your suggested change wasn't added." | |
| `proposal_stale` | "your suggestion needs a quick update." | |

`record_updated` is owned by the notifications domain (R-11/R-12); this domain only produces it.

**The gates adapter (client, `islands/src/lib/proposal-gate-source.js`).** `createProposalGateSource(api)` implements `GateSourceLike {id, list, decide}` (`gates/src/react.tsx:10`). It maps each ProposalView to a `GateCard` (`gates/src/types.ts:122-165`):

| GateCard field | Value |
|---|---|
| `id` | the proposal id |
| `project_id` | `"harrisonfamily"` |
| `kind` | `"acceptance"` |
| `family` | `"decision"` |
| `risk` | relationship or destructive → `"medium"`, otherwise `"low"` |
| `state` | pending → pending; needs_changes → snoozed; stale → pending with `diff.drift = true`; approved, rejected or withdrawn → decided; superseded → superseded |
| `subject` | `{record_id: "Person:<h>", project: "harrisonfamily", version: String(base_version)}` |
| `evidence` | `[{label: "suggested by", ref: "person:<gramps_id>"}]` |
| `onExpire` | `"regenerate"`, with **no** `expiresAt`, so `sortByExpiry` falls back to ULID order, which is FIFO (`react.tsx:174-181`) |
| `etag`, `title`, `why.summary`, `diff`, `createdAt` | from the proposal (`why.summary` is the note) |
| `requiredAuth` | destructive → `"step_up"`, otherwise `"interactive_human"` |
| extra field `hfy` | the full ProposalView |

`decide(input)` maps to `POST /api/proposals/:id/decision`, with `If-Match: input.etag` and `Idempotency-Key: input.idempotencyKey`. "Ask for changes" is not a gates verdict, so the HFY card calls the API directly for it.

The review island uses `useGateInbox([source], filter)` (`react.tsx:185-221`) with a `renderCard` built from HFY's `ProposalCard`. The default `GateCardView` shows developer-facing JSON, a "Clear" button and "Snooze 1h", so it is not used.

### 7.5 Stale proposals: three-way rebase

`base` = the value each op recorded, `current` = the store now, `proposed` = `op.value`.

| Op | Clean when | No-op when |
|---|---|---|
| set | `current@path` deep-equals `base` | it equals `proposed` (already applied) |
| add | the target list exists and the key is absent | an identical element is present |
| remove | the element is present with the same content hash | it is absent |
| move | both keys are present | |
| create | always | |
| delete | the object exists and its hash equals the base hash | |

- **Rebase status.** If every op is clean or a no-op, the status is `clean`. The admin card shows "the page changed since; this suggestion still applies" and approval proceeds. Otherwise the status is `conflict`, and the per-op conflict rows show base, current and proposed.
- **Proposer path.** "Update my suggestion" refetches the bundle and re-seeds the editor with the proposer's values. Ops that did not conflict are kept. Conflicting fields show "the page now says X — keep yours or use the new value?". The amend goes out with fresh base_versions.
- **Admin path.** "Edit then approve" works the same way, inside the review card.
- **Superseded.** If the target is deleted or merged on the desktop (`records.get` returns null and a CHANGE# delete exists), the proposal becomes `superseded`. The proposer is notified with `proposal_stale`, with the copy "the page was merged or removed".
- **No expiry** (DEC-E7). Family pace is slow, and gates' 30-day maximum (`gates/src/model.ts:10`) is the wrong model here.

### 7.6 MCP (D-16 parity)

New tools, each with its own handler, a `POLICY_ROWS` row and an entry in `api/parity/map.yaml`:

| Tool | Route | Who | agentMode |
|---|---|---|---|
| `hfy_records_get` | `GET /api/edit/:cls/:ref` | mcp-authors, hfy-admin | |
| `hfy_changes_submit` | `POST /api/changes` | mcp-authors, hfy-admin | `dry_run`, so agents preview first |
| `hfy_proposals_list` | `GET /api/proposals` | | |
| `hfy_proposals_get` | `GET /api/proposals/:id` | | |

There is **no decide tool** in v1. Approving is a human action in the site UI, like publishing posts (`routes.js:50-52`); see DEC-E5. Without a policy row a tool stays hidden (`policy.js:27`).

---

## 8. Relationship wizard (R-24)

### 8.1 Gramps semantics it reproduces

- Gramps labels the slots "Father/partner1" and "Mother/partner2". The wizard puts male → father_handle and female → mother_handle. Otherwise the first person chosen goes in partner1 and the second in partner2 (same-sex couples are supported).
- Links are maintained on both sides (§6.2).
- **Existing families are reused** before a new one is created. This is Gramps' own warning in reverse: "It is possible to accidentally create multiple families with the same parents" (`editfamily.py:436-458`).
- ChildRef `frel`/`mrel` carry the relationship to each parent:

  | Wizard label | ChildRefType |
  |---|---|
  | birth parent | Birth (1) |
  | adoptive | Adopted (2) |
  | step-parent | Stepchild (3) |
  | foster | Foster (5) |
  | not sure | Unknown (6) |
  | more options | Sponsored (4), None (0) |

- New parent families get type Unknown (3), the majority value (39 of 57). Spouse families get the type the member chooses.
- Marriage events go on the family with role Family (8), not on the persons. The tree has a Bride/Groom quirk in 5 refs, which stays untouched.
- `parent_family_list` order matters: the first entry is the main parents. New adoptive or step families are appended, so birth parents stay main.

### 8.2 Intents (the client sends intents; the server compiles ops)

```jsonc
// "my parents" (also new members choosing existing records as their parents)
{ "type": "parents", "person": "Person:<me>",
  "parents": [ { "who": { "ref": "Person:<h>" } | { "new": Stub }, "rel": "birth|adopted|step|foster|unknown|sponsored|none" } ] }  // 1 or 2
// "my children"
{ "type": "children", "person": "Person:<me>", "otherParent": { "ref": … } | { "new": Stub } | { "unknown": true },
  "children": [ { "who": { "ref": … } | { "new": Stub }, "relToMe": "birth|…", "relToOther": "birth|…" } ] }      // ≤10
// "my spouse or partner"
{ "type": "spouse", "person": "Person:<me>", "spouse": { "ref": … } | { "new": Stub },
  "relType": "married|unmarried|civil_union|unknown",
  "married": { "year": 1990, "about": false, "place": { "ref": "Place:<h>" } | { "new": { "name": "…", "type": "City", "enclosedBy": "Place:<h>" } } } | null,
  "ended": { "how": "divorced|widowed", "year": 2001 } | null }
// "something's wrong" (unlink; destructive)
{ "type": "unlink", "family": "Family:<h>", "person": "Person:<h>", "as": "child|partner" }
// Stub = { "given": "…", "surname": "…", "gender": "female|male|unknown", "birthYear": 1950|null, "living": "yes|no|unknown", "deathYear": null }
```

**Compiler** (`api/src/records/relationships.js`, pure, run against `records.graph()` and the current objects):

- **parents**
  1. Look for a family whose parent set equals the chosen set. If found, add the ChildRef and the `parent_family_list` entry, or report "already recorded".
  2. With one parent chosen, reuse that parent's family that has an empty other slot.
  3. Otherwise create a Family and add it to each parent's `family_list`.
  4. Never fill the empty slot of an existing single-parent family that has other children. That would silently give those children a new parent. Instead, warn the admin: "consider merging in Gramps".
- **children**
  1. Find the family with the same parent set, or the member's single-parent family when the other parent is unknown; otherwise create one.
  2. Add each child on both sides.
  3. If the child already has Birth/Birth parents elsewhere, add a warning.
- **spouse**
  1. Reuse the family with the same pair, updating `type` if it differs; otherwise create one and add it to both `family_list`s.
  2. Add a Marriage event (year only in the wizard; month and day are allowed by the rules but kept out of the wizard for simplicity) and a Divorce event when `ended.how = divorced`.
  3. When widowed, offer "add their death year", which becomes a Death event proposal on the spouse's page.
- **Stubs** become a Person:
  - `primary_name` {first_name, one surname with primary=true, type Birth Name} and the chosen gender;
  - a Birth event that is year-only (if a year was given);
  - a Death event when `living = no` and a year was given.

  The stub carries an empty gramps_id; the sync policy assigns one (DEC-E13).
- **Every compile** also runs the cycle check, the two-sided link check and the guard.
- **Duplicates.** Before creating a stub, the server searches names (case-folded, accent-stripped) and returns `duplicates:[{for: "new:1", candidates: [{handle, displayName, lifespan}]}]`. The client must list each `new:n` it confirmed in `confirmDistinct` before the submit is accepted.

**Routes:**

- `POST /api/relationships/preview {intent}` → 200 `{ops, base_versions, summary[], warnings[], duplicates[]}`.
- `POST /api/relationships {intent, confirmDistinct[], note?}` (Idempotency-Key) → 201 `{proposal}`. For an admin with `route: "auto"` it returns `{applied}` instead.

Members always get a proposal (R-24: these are relationship proposals). Errors are the same as `/api/changes`, plus `422 unconfirmed_duplicate`, `422 cycle`, `409 already_recorded` (informational) and `422 too_many_children`.

**Integration point.** The sign-up domain (R-23) can turn Legacy Form S10 (father's and mother's names and birth years) into a `parents` intent for a new member, with stubs, through the same compiler.

### 8.3 UX for older, non-technical members

**Entry points:**

- On the member's own page, the family section (`person-family-section`, `person-page.js:20-26`) gets a button: "add or fix family connections" → `/edit/family/?id=<me>`.
- The editor's "family" section links to the same place.

**Rules for every screen:**

- One question per screen, in plain words. No "family", "ChildRef" or "relationship type" jargon.
- Choice targets are **56 px** tall (above the D-11 44 px floor). Inputs are 16 px.
- High contrast, with the DS tokens only (theme-lint).
- A visible step count, for example "step 2 of 4".
- **Back** on every screen. **Undo** reverses the last change to the draft.
- Nothing is sent until the summary screen.
- The draft persists in `sessionStorage` (per-viewer convenience), so a refresh does not lose work.

**Flow "my parents":**

1. "Let's add your parents." Choose: "my mother", "my father", or "another parent" (partner1/partner2 wording is hidden).
2. "Who is your mother?" Search existing family. Search results are big rows showing name, birth year (shown only to members, as on the site today) and a small photo.
   - Or tap "she isn't on the site yet" → a short form: given names ("first and middle, as on the birth certificate", the Legacy Form S1 wording), maiden last name, birth year (optional, year only), and "is she living?" (yes / no / not sure).
   - Duplicate check: "is this the same person?", showing the candidates and asking "yes, that's her" / "no, someone else".
3. "How are you related to her?" Choices: birth mother / adoptive mother / stepmother / foster mother / not sure. "More" reveals sponsored and none.
4. Repeat for the second parent, or "that's all".
5. **Summary**, in sentences, with an edit link on each line:
   - "You're telling us: [name] is your birth mother. [name] is your birth father. They are partners."
   - "An admin will check this before it shows on the site. You'll get a notification."

   Buttons: **Send for review** (primary) and **Go back**.

**Flow "my children":**

1. "Who is the other parent?" Choices: your spouse or partner (pre-listed), someone else, or "I'd rather not say / not sure".
2. Add each child: search, or "not on the site yet" (given names, last name, birth year, living?). A chip list shows the children added so far, each with a remove ×.
3. Per child, the relationship to you and to the other parent. The default is birth, with "change" available.
4. Summary, then send.

**Flow "my spouse or partner":**

1. Who (search, or new).
2. "Were you married?" Choices: married / partners, not married / civil union / not sure.
3. "What year did you marry?" (optional), plus "about" and place (search existing places, or "not listed").
4. "Is the marriage still going?" Choices: yes / divorced (year) / widowed (offers "add the year they died").
5. Summary, then send.

**After sending.** A toast: "sent. you can change or withdraw it until an admin looks." It links to `/me/review/?tab=mine`. Withdraw is the post-submission undo.

**Layouts:**

- **375 px:** full-width cards and a sticky footer above the bottom bar (`--io-shell-safe-*` tokens). No horizontal scroll, and long names wrap.
- **≥ 43 rem:** a centred 40 rem column.
- **≥ 64 rem:** a right-hand "your family so far" panel, as a text list with no SVG, that updates as the member answers.

---

## 9. UX: editor and review queue

### 9.1 Record editor (`/edit/?cls=person&id=<gramps_id>`, island `editor`, flag `recordEdit`)

**Entry points.**

- The person page hero (`renderHero`, `person-page.js:318-343`; injected by the `edit-entry` part of the editor island) shows:
  - own page: "edit my info";
  - other people's pages: "suggest a change";
  - admins: "edit".
- It sits beside the R-21 gear on the member's own page.
- If any proposals are pending on the page, a chip says "2 suggested changes waiting for review".

**Sections** mirror the Gramps tabs, in plain language:

- **names**: given names, last name at birth, name you go by, nickname, title, suffix, plus "also known as";
- **life events**;
- **facts** (attributes);
- **notes**;
- **photos** (order and primary photo; tagging → R-31);
- **links** (→ R-16 surface);
- **people connected to you** (associations);
- **sources** (citations);
- **family** (→ wizard);
- **more** (admin-only fields, admins only).

**Fields:**

- Every field shows a mode badge with an icon and text, never colour alone: "saves now", "goes to review" or "only an admin can change this".
- Never-in-cloud items explain why. For example, a birth date shows the year only, captioned "we only keep the birth year on the site".
- A pending suggestion on a field shows "a change is waiting for review".

**Forms.** One `SchemaForm` per section, with form schemas, `initialValues` taken from the bundle, and `onValueChange` → EditOps. Custom widgets come through the kit 0.4 host-widget ids:

- `grampsDate`: a year input, then optional month/day (hidden for Birth), plus about/before/after/between and estimated;
- `personRef` over `suggestPeople` (`islands/src/lib/people-corpus.js:121`, adapted to `RefTypeaheadSource`);
- `placeRef` over the places in the bundle.

**Submitting:**

- A sticky bar counts the changes: "3 changes — 2 save now, 1 goes to review".
- **Review** opens the confirmation sheet, which lists the dry-run summary sentences, grouped "saves now" and "sent for review".
- **Save** shows a toast: "saved." with **Undo** (10 min) and "1 suggestion sent".
- A `version_conflict` triggers an automatic refetch and replay of the member's ops, then: "this page just changed — please check your edits."

**Layouts:**

- **≥ 64 rem:** a sticky section index on the left and the form cards on the right. Sub-items (an event, a note) open inline as an expandable panel.
- **≥ 43 rem:** a single column.
- **375 px:** each section is a 56 px accordion header. A sub-item opens as a full-screen kit Sheet with "back" and "done". The submit bar sits above the bottom nav. Inputs are 16 px, one control height per row, and nothing scrolls horizontally.

**Other classes.** Event, Place, Source, Citation, Repository, Media metadata, Note and Family use the same island, at `/edit/?cls=<class>&id=<gramps_id | h:handle>`. They are reached by drilling down, as in Gramps: event → place, citation → source → repository. For members the whole form is "goes to review".

### 9.2 Review and suggestions (`/me/review/`, island `review`)

**Tabs:**

- **to review**, admins only (flag `proposalReview`);
- **my suggestions**, everyone;
- **about my page**, everyone.

The R-21 settings hub links here, and the shell badge (notifications domain) shows the pending count to admins.

**Admin list:**

- Filter chips: waiting, needs changes, out of date, done.
- Oldest first.
- Each row shows the proposer, "about [page name]", the age of the suggestion, a kind badge (edit / family connection / new person) and the first summary sentence.

**Detail card** (`ProposalCard` via `renderCard`):

- **Edits:** per-op rows of before → after, with a word-level diff for names.
- **Relationship proposals:** a sentence list ("adds [name] as a child of [name] and [name]") plus a mini indented tree, as text.
- Warnings: possible duplicate, out of date (conflict rows highlighted), already has birth parents.
- The proposer's note.
- The comment thread (the `Comments` component, subject `proposal:<id>`).
- **Actions:**
  - **approve** (primary);
  - **ask for changes** (message required);
  - **decline** (reason required);
  - **edit then approve** (opens the editor in amend mode).
- Destructive approvals show: "you'll be asked to sign in again to confirm."

**Proposer view:** state chips in plain words.

| State | Chip |
|---|---|
| pending | "waiting for review" |
| needs_changes | "an admin asked a question" |
| stale | "needs a quick update — the page changed" |
| approved | "added to the family tree" |
| rejected | "not added: [reason]" |

Actions: edit (pending, needs_changes or stale), withdraw, reply.

**Layouts:**

- **≥ 64 rem:** a 40/60 list and detail split.
- **375 px:** list → detail as a separate view, with the actions in a sticky footer and the reason entry in a Sheet.

---

## 10. Kit changes

**`@io-kit/schema_form` 0.4.0** (io-kit, one package, one PR, HFY-R7) adds:

1. **A React-free `./core` subpath.** It exports `validateValue`, `mapServerProblem`, the pointer helpers, the hash helpers and the types. Today the root re-exports `SchemaForm` (`src/index.ts:15`), which would pull React into the Lambda.
2. **Host-registered widget ids.** Today `x-io-widget` resolves only against the built-in `WIDGET_IDS` (`walker.ts:71-72`). After the change it also resolves against the keys of the host's `widgets` registry, so HFY can register `grampsDate`, `personRef` and `placeRef`.
3. **A `fieldAdornment(pointer, node) → ReactNode` hook.** It renders beside each field's label, for the "saves now" / "goes to review" badges. `fieldPolicy` only supports show/readonly/hide (`form.tsx:13`, `:141`).

The minor bump carries tests, a changeset with `doc_impact`, and README updates.

**`@io-kit/gates` 0.1.2:** no change. HFY consumes `GateSourceLike`, `useGateInbox`, `parseGateCard` and `makeIdempotencyKey` as they stand.

**HFY installs:**

- `islands/package.json` adds `@io-kit/schema_form@0.4.0` and `@io-kit/gates@0.1.2`, plus the peer `@tanstack/react-form@1.33.5`.
- `api/package.json` adds `@io-kit/schema_form@0.4.0` (the `/core` subpath only) and fixes the two range pins, content and notify, to exact versions (digest risk).
- These packages load only on `/edit/`, `/edit/family/` and `/me/review/`, never in the shell bundle.

---

## 11. Flags, configuration and rollout

| Flag or switch | Where | Default | Gates |
|---|---|---|---|
| `HFY_EDITING` | app-stack parameter → hfy-api env | off | Every route in §7. 404 while off. |
| `recordEdit` | `11ty/_data/flags.json` plus the runtime override `?hfy_flags=` (HFY-R42) | off | `/edit/`, the edit entry on person pages, and the "my suggestions" and "about my page" tabs |
| `proposalReview` | flags | off | The "to review" tab. The server enforces `actor.admin` regardless of the flag. |
| `relationshipWizard` | flags | off | `/edit/family/` and the family-section button |

New names avoid the existing `notifyV2` (digest risk). The loader routes go in `11ty/js/feature-flags.js:762-829`, and the islands are listed in `bundle.test.mjs`. The three repo-owned pages `/edit/`, `/edit/family/` and `/me/review/` are added to `islands/heads.mjs` PAGES, `copy.mjs`, the README lists and the Dropbox Eleventy source mirror (HFY-R46). Build outputs are committed (HFY-R58).

**Rollout order** (HFY-R8, D-11):

1. **Hard prerequisites (sync domain).** The cloud store is the source of truth, `records.apply` is live, and the S3 projection renders cloud changes. The ETL `sync_to_s3.py --delete` is retired for the record prefixes; otherwise a desktop export would overwrite approved edits.
2. **io gate `G-admins`.** io names approvers in `config/admins.json`, at minimum his own principal (DEC-E2). Publishing that list needs io (HFY-R70).
3. Deploy the API with `HFY_EDITING=on` and the flags off.
4. io runs UAT on production through `?hfy_flags=recordEdit,proposalReview,relationshipWizard`.
5. Run the D-11 audit per surface: 16 px inputs, 44 px targets (56 px in the wizard), one control height per row, no horizontal scroll at 375, axe clean, and the installed iPhone PWA.
6. **io approval to flip**, in this order: `proposalReview` (admins only), then `recordEdit`, then `relationshipWizard`.
7. **Rollback** is flags off and then `HFY_EDITING=off`. Proposals stay stored. Applied changes can be reverted with inverse ops (audited), or by io in Gramps.

---

## 12. Testing

- **Unit** (api, vitest; the existing fake DDB extended with ConditionCheck by `sync-op-api`):
  - **Field policy:** an exhaustive matrix of class × pointer × own/other × member/admin. A golden test reproduces R-09 exactly: given names, surnames, name type, alternate-name first and surname, birth date and parent links are proposals for the owner; title, suffix, call, nick, famnick and gender are direct. Every schema pointer has a row.
  - **Ops engine:** property tests (random op sequences: apply then inverse = identity; rebase is clean when paths don't overlap), key-segment addressing under reordering, and temp-handle minting.
  - **Semantics:** dates and `sortval` against fixtures generated by Gramps' own `Date` on synthetic dates; both-sides link invariants; cycle detection; derived index recompute against `set_birth_death_index` fixtures.
  - **Relationship compiler:** golden fixtures produced by running Gramps' own DB API under the bundle shim on a **synthetic** tree (people named with placeholders, ids I9001…). Each scenario covers family reuse and the single-parent family rule.
  - **Guard:** synthetic positive and negative corpora (phones, street addresses, DOB phrases). Tests assert that responses and logs never echo the matched text.
  - **Proposals:** state machine, idempotency replay, visibility (proposer, admin, owner, others → 404), 412 on a stale etag, two admins racing (exactly one wins), the destructive step-up rule.
- **Contract:** `gen-edit-schemas --check`, caps regen includes the new routes, the MCP tool and policy-row parity test (`parity/map.yaml`), and the gates adapter output passes `parseGateCard`.
- **Islands** (node --test plus Playwright against a mocked API):
  - editor: badges, the split confirmation, undo, conflict replay;
  - wizard: all three flows plus unlink, duplicate confirmation, back and undo;
  - review: approve, ask for changes, decline, stale, edit then approve;
  - all at 375 and 1280, with axe, no horizontal scroll and theme-lint.
- **Cross-domain integration** (in the sync domain's plan, referenced here): an approved proposal → CHANGE# → the desktop addon dry-run applies it to a scratch Gramps tree, and Gramps "Check and Repair" reports zero issues.
- **Privacy:** fixtures use synthetic ids (I9001/I9002, as the existing tests do) and placeholder names only.

---

## 13. Error-handling catalog

| Code (HTTP) | Raised by | Cause | Server behaviour | UI copy (DS voice) and recovery |
|---|---|---|---|---|
| `unauthenticated` (401) | `handler.js:80-81` | No or expired session | – | Silent refresh (HFY-R66), then sign in |
| `not_found` (404) | all | Editing off, no such record, or proposal not visible | – | "this page isn't available." |
| `ambiguous_id` (409) | edit bundle | gramps_id maps to more than one object | lists the handles | Admin: choose one. Member: "text an admin." |
| `validation` (400) | schema, semantics | Invalid value, date, reference or call name | `errors[]` pointers | Inline at the field (`mapServerProblem`) |
| `not_allowed` (403) | field policy | Op on an admin, desk or never path. Detail `kind: "url_not_link"` when a Person Url is not one of the link kinds (Web Home, or a Custom type named for a link kind): desktop-only (HFY-TSK-329; edit-api-core maps `desk` to this response, mapping of Web Home / Custom names awaits io confirmation) | `errors[]` paths, `kind` | "only an admin can change this." |
| `contact_info` (422) | guard | Phone, address or email detected | spans only, never echoed, logs carry counts only | Inline highlight: "this looks like a phone number or street address… please remove it." Submit stays disabled. |
| `dob_not_allowed` (422) | guard | Day or month on a birth date, or a DOB phrase | spans | "we only keep the birth year on the site." |
| `never_in_cloud` (422) | guard, schema | Address, location, e-mail URL (detail `kind: "url_email"`, field policy), SSN or ID attribute, street-level place | `kind` |  "we don't keep this on the site." |
| `version_conflict` (409) | `records.apply` | Direct group's base is stale | `current` versions | Refetch and replay automatically, then "this page just changed — please check." |
| `precondition_failed` (412) | proposals | Etag changed: amended, or another admin decided | fresh view | Card re-renders: "this suggestion changed; please look again." |
| `rebase_conflict` (409) | decision | Record changed and the ops overlap | state → stale, proposer notified | Admin: conflict rows plus "edit then approve". Proposer: "needs a quick update". |
| `step_up_required` (401) | decision | Destructive approval with `auth_time > 900 s` | – | Re-sign-in, then return to the card |
| `invalid_state` / `not_amendable` (409) | proposals | Already decided or withdrawn | – | "this suggestion was already handled." |
| `unconfirmed_duplicate` (422) | relationships | Stub matches existing people | candidates | The "is this the same person?" screen |
| `cycle` (422) | semantics | Would make someone their own ancestor | – | "that would make someone their own ancestor — please check who's who." |
| `too_many_children` / `too_large` (422/413) | caps | Over 10 children, 50 ops or 64 KB | – | "please send these in smaller batches." |
| `rate_limited` (429) | changes | Over 50 proposals in 24 h | – | "you've sent a lot today — try again tomorrow." |
| `idempotency_mismatch` (422) | changes, decision | Same key with a different body | – | The client generates a new key and retries once |
| `not_admin` (403) | decision, queue | Caller is not in admins.json | – | The tab is not shown |
| `unavailable` (503) | store | DynamoDB or sync store error | nothing written (one transaction) | "that didn't work. try again." The draft is kept. |
| Post-commit notify failure | producers | Push or inbox error | logged, the write stands (`handler.js:15-21` pattern) | – |

---

## 14. Decisions

See the structured summary for the full list. The key ones:

- **DEC-E1:** reuse the gates contract (§7.4).
- **DEC-E2:** approvers are the admins in `config/admins.json`, and io names them.
- **DEC-E3:** literal R-09.
- **DEC-E4:** web DOB proposals are year-only.
- **DEC-E5:** no MCP decide.
- **DEC-E6:** split mixed submissions.
- **DEC-E7:** no expiry.
- **DEC-E8:** desktop-only operations.
- **DEC-E9:** fresh sign-in for destructive approvals.
- **DEC-E10:** no new custom types from members.
- **DEC-E11:** styled notes.
- **DEC-E12:** street-level places, and baptism/christening treated as DOB proxies (io).
- **DEC-E13:** the gramps_id policy defers to the sync domain.
- **DEC-E14:** no delegation.
- **DEC-E15:** a server kill switch.
- **DEC-E16:** proposal visibility.

## 15. Risks

These are listed in the structured summary. The top ones:

- **Sync-domain prerequisites.** If ETL `--delete` overwrites cloud edits, approved changes vanish.
- **Corrupting Gramps' two-sided links.** A bug here corrupts the tree on the desktop pull.
- **Empty admins list.** Until io names approvers, nobody can approve.
- **Guard false negatives.** Free-text addresses are hard to detect; admin review is the second line.
- **Wizard duplicates.** Older members may create duplicate people.
- **Bundle weight** of TanStack Form plus the validator.
- **Privacy of unreviewed claims.** Pending suggestions hold unreviewed statements about living relatives in DynamoDB. The privacy terms need a "suggested changes" row: §3.3 "what you add" and the retention section, both drafted for io in the docs task.
