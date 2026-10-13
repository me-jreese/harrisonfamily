# HFY-PLN-002 design: visualization overhaul (domain `viz`)

Requirement: **R-22**, a state-of-the-art visualization that uses desktop space to tell the family story and works on a phone without turning into tiny images. io's claude.ai research job decides the approach (research-first).
Related requirements: R-18 and R-19 (the projection in §5.2 enforces them for every viz output), R-20 (the family tab, §10), R-29/R-31 (face crops reuse the Gramps region rects, §5.5), R-03 (the graph is generated from the cloud store, §5.7).
Status: design draft. No repo was edited. All examples use invented people and places.

---

## 1. Problem

Today the site has exactly one family visualization: a static Graphviz SVG per person, drawn at export time.

- **Source.** The out-of-repo ETL `scripts/etl/build_family_tree_media.py` reads the raw Gramps DB and writes `media/tree_<gramps_id>.svg`, 231 files.
- **What it shows.** Each SVG shows five generation rows: grandparents, parents, the person with siblings and spouses, children, grandchildren. It has no aunts, uncles or cousins, no photos, no places and no time beyond the lifespan text.
- **How the page renders it.** `11ty/js/person-page.js:694-769` (`renderFamilyVisualization`) fetches the SVG through `dataFetch` and puts it in a pan and zoom frame (`TREE_ZOOM` 0.4 to 3, `:49`). The node role is recovered from the fill colour (`TREE_FILL_ROLES`, `:41-48`), a stop-gap. A 16 px label floor (`TREE_LABEL_FLOOR`, `:51`) decides whether the first view can be "fit".
- **Limits.** The tree cannot re-centre on another person. On a phone it is a wide canvas you pan around (since 863293c).
- **Nothing else.** The repo has no graph, layout or map library (`islands/package.json`), and no graph JSON exists.

The data is small but messy. These figures come from the read-only DB copy, digest gap-fill "visualization":

| fact | value | design consequence |
|---|---|---|
| people / families / events / places / media | 231 / 57 / 169 / 37 / 32 | One graph file is tiny. Design for about 2,000 people (the research prompt's scale target). |
| connected components | 1 of 221 people + 10 singletons | We need a "not yet connected" group and per-component generations. |
| longest parent-to-child chain | 8 people | About 8 generation levels. |
| child links | 169 Birth/Birth, 2 Unknown/Unknown | No adopted, step or foster links yet, but the model must carry them. |
| partner families | 2 people with 2 families; 8 mother-only families; 2 childless families | Model families as unions with 0 to 2 partners. |
| people with no parents | 60 (most are married-in spouses) | Generation alignment of partners is needed (§5.4). |
| dates | 164 of 169 year-only; 4 full dates; 1 span | The graph carries years only, which costs us nothing. |
| places | 37: hierarchy of at most 3 levels; 0 with lat/long; events use 23 leaf places; 60 of 169 events have a place; one city holds 26 of the 60 | Geocoding must happen at build time and offline (§5.6). The map is a v2 layer, not the backbone. |
| photos | 26 people have any media; 32 region rects (integer percent) on 23 photos; 21 primary photos carry a rect | Face crops from regions (§5.5); initials avatar for the other 205 people. |
| media binaries | 14 of 29 Dropbox files are 0-byte online-only placeholders | Treat a 0-byte file as missing (§5.5). |

Privacy constraints that already bind:
- **R-19:** no day or month of birth in the cloud.
- **R-18:** no contact information.
- **Members only:** living people's data is visible only to signed-in members (`docs/explanation/family-data-privacy.md:12`).
- **The gate:** gated responses are `private, no-store` (HFY-R63, HFY-R65).

## 2. Scope, non-goals, rulings

**In scope:**
- recording the research decision (§4);
- three data prerequisites that can start now: the graph JSON, face crops and offline geocoding, plus the generation index (§5);
- the MVP (the `/tree/` page as the family tab destination, the accessible outline and focus navigator, and the research-chosen visual), then v2 (places, time, kinship finder, Graphviz retirement, cloud-store regeneration);
- budgets (§11, §12).

**Non-goals:**
- no new API route (§7);
- no new io-kit package (§13);
- no editing of relationships from the viz, which belongs to R-24's domain (the viz only links to it);
- no public, signed-out view;
- no third-party tile, geocoding or analytics calls, ever.

**Rulings respected:**
- **Flags and the audit:** HFY-R8 (default-off flag; flip after the D-11 audit and io approval), HFY-R42 and HFY-R58 (session-scoped `?hfy_flags=` override with a banner).
- **Pages and builds:** HFY-R46 (mirror repo-owned pages to the Dropbox Eleventy source), HFY-R47 (island pattern), HFY-R58 (committed built bundles).
- **Gating:** HFY-R63 and HFY-R65 (gated, `private, no-store`).
- **Process:** HFY-R10 (io-only steps go out as handoffs), HFY-R16 (audit assets), HFY-R70 (flip order: flags deploy first; sync the Dropbox flags), HFY-R72 (DS tree tokens).
- **Data handling:** "Family data never goes through Git or CI" (`docs/how-to/refresh-the-family-data.md`).

**Ruling superseded (proposed):**
- **HFY-R74, first clause:** "The family tab is the member own family page (/person/?id=<sub>)". Reason: io's R-20 moves the own page to the "me" tab, so "family" needs a new destination, and this design makes it `/tree/` (§10).
- **What R74 keeps:** "/private/ is a redirect" stays, but the redirect now goes to `/tree/`. "A full A-Z directory is not in the DS spec (search covers it)" stays as written: the outline in §12.3 is a relationship outline, not an A-Z directory.

## 3. Architecture overview

```
 Gramps 6.0.6 SQLite (io's Mac)            cloud record store (sync domain, R-03)
          | read-only copy, mode=ro               | redacted Gramps-JSON snapshot (ARCH-C JSONL)
          v                                       v
   sqlite3 -readonly ... | ----------------> RecordSource: `_class`-tagged Gramps JSON objects, one per line
                                                  |
                                     graph/ (new Node 22 package in the harrisonfamily repo)
                       +--------------------------+---------------------------+-------------------+
                       | project.mjs (allowlist   | generations.mjs (§5.4)    | geocode.mjs (§5.6)| faces.mjs (§5.5)
                       |  projection, §5.2)       |                           | offline GeoNames  | sharp crops
                       +--------------------------+---------------------------+-------------------+
                                                  | buildFamilyGraph() -> graph + face jobs; verify(); atomic write
                                                  v
      staging tree: person/graph.json, media/faces/<id>-<sha8>.webp   (+ local graph-build-report.json, never synced)
                                                  | today: sync_to_s3.py (person/, media/ prefixes); later: the cloud renderer
                                                  v
      s3://harrisonfamily-frontend/person/graph.json  +  media/faces/*   (gated: /person/*.json, /media/* + hfy-edge-gate)
                                                  |
                                                  v  dataFetch (session cookie, refresh/retry, R66)
      /tree/  (repo-owned static page)  ->  island "tree" (flag familyViz)
            lib/family-graph.js (index, queries, kinship)  ->  FocusNavigator + GenerationOutline (always)
                                                            ->  ChartView (lazy chunk, research-chosen)
                                                            ->  v2 layers: Places (lazy), Time (lazy)
      /person/?id=X  ->  "see in the family tree" link -> /tree/?focus=X   (v2: embedded mini focus view replaces Graphviz)
```

## 4. Research intake and gating

### 4.1 What the research decides, and what it does not

The research decides:
- **The concept.** The desktop "story" concept and the library that powers it.
- **The phone pattern.** The phone visual pattern on top of the focus navigator, for example a generation carousel or swipeable family cards.
- **Scope.** The MVP cut versus v2 and the order of the v2 layers (places, time, photos, kinship).
- **Build-time work.** Whether any layout is precomputed at build time. If so, an additive `layout` block is added to graph.json and `minor` is bumped (§5.3).
- **The basemap.** The v2 basemap technology (§5.6.4).

These are fixed regardless of the research outcome. They are invariants, and the intake rejects any recommendation that breaks them:
1. **Data.** The data contract is graph.json v1 (§5.3); only additive changes are allowed. It contains years only, follows the privacy projection (§5.2), and is served from existing gated prefixes (§6).
2. **No third parties.** The page sends nothing to a third party: no keyed tile or geocoding API, no CDN fonts, no analytics.
3. **Licences.** Only permissive licences (MIT, BSD, ISC, Apache-2.0) ship in the bundle. GPL, AGPL, EPL, commercial or SaaS-only code is rejected at intake. MPL is allowed only for test tooling.
4. **Phones.** No pinch-and-pan canvas as the primary phone interaction. The focus navigator and outline (§12.3) are always present.
5. **Budgets.** The budgets in §11 and §12 hold. The research may propose different numbers, with evidence, and io approves them in the ADR.
6. **Route and flag.** The surface is `/tree/` behind flag `familyViz`, as the family tab destination (§10).

### 4.2 The intake (task `viz-research-intake`, no_code)

1. **Store the report.** Store io's research report as a docstore document linked to HFY-PLN-002.
2. **Check the facts.** Check the report's data claims against the discovery facts in §1, as the gap-fill did for the prompt draft. Contradictions are listed in the ADR.
3. **Score every candidate library.** For each one, record:
   - its licence;
   - the date of its last release (it must be within 12 months, or justified);
   - its gzip size, from `npm view` plus an esbuild bundle of a one-line import in a scratch directory (never in the repo);
   - evidence of phone quality;
   - how it handles the messy cases: two partner families, single-parent unions, parentless siblings, step and adoptive links, pedigree collapse, disconnected people;
   - any data it needs beyond graph v1.
4. **Write the ADR.** Write the ADR as a docstore decision document. It records:
   - the chosen concept;
   - the desktop layout and the 375 px layout;
   - libraries with exact versions;
   - what is precomputed and what runs in the browser;
   - any graph.json additions;
   - the MVP and v2 task cut;
   - any budget changes.
   Then amend §4.3 here and the notes of `viz-mvp-visual`.
5. **Get io's approval (VIZ-D1).** Send the ADR to io as a handoff (HFY-R10). `viz-page-shell` and the tasks after it are not checked out before io approves.

### 4.3 Chosen approach

**Decided.** This is the Q2-13 default in BRD2 section 6.5, the verified recommendation. io answered sheet item Q9 (Q2-13 with Q2-14) on 2026-10-13 with "all approved. proceed." (decision sheet DOC-C31D9E3DD932). The answer is recorded in the viz ADR, DOC-A4FBA13AE98A, section 4.1. It approves the recommendation together with its budget changes (§11).

- **MVP: Concept A, the Family Card Navigator** (flag `familyViz`).
  - A framework-free `<family-navigator>` custom element in the lazy chart chunk: our own code, light DOM, no React inside it and no third-party tree library (family-chart is not embedded).
  - On a phone it shows one family at a time as large cards: the focus card, a parents strip, one tab per partner family and a row of children, with the details in the kit `Sheet`. From 64rem it widens into a four-row card grid.
  - There is no pan-and-zoom canvas. Every swipe has a visible button, and arrow keys walk the family.
  - The outline and focus navigator (§12.3) stay the accessible path and the fallback.
- **v2: C-lite lifelines, Faces and a desktop big-tree poster.**
  - Lifelines (`familyVizTime`): per-person and per-family lines by decade, with the TimeNets fade for uncertain dates. Era bands come only from io-approved copy (VIZ-D12).
  - Faces (`familyVizFaces`): "pictured with" chips and a faces tab.
  - The poster (`familyVizBigTree`): a whole-family view for desktop whose layout d3-dag 1.2.2 precomputes at build time, so no layout code ships to the client.
  - The kinship finder keeps its own flag (`familyVizKinship`).
- **v3: Journeys** (`familyVizJourneys`).
  - A map story on maplibre-gl 6.14.0 (never v5), pmtiles 4.5.0 and @protomaps/basemaps 5.7.2.
  - It reads a self-hosted maxzoom-11 PMTiles extract with versioned file names and a Cloudflare Cache Rule (gate G-map).
  - It loads only on the map view, and falls back to the outline's places list without WebGL2.
  - There is no v2 places layer (VIZ-D11).
- **In the ADR:** the desktop and 375 px layouts (its 4.5), what is precomputed (4.6), the additive graph.json fields `layout` and `photoEdges` (4.7), the cut (4.8) and the 1-3 day task re-cut (section 9).

**Fallback (not used, because io did not reject Q2-13).** If io had rejected the recommendation, the fallback was a **focus+context hourglass**:
- **Desktop:** 2 generations up, 2 generations down, partners beside, siblings in a collapsed row, with photo nodes.
- **Phone:** the focus navigator of §9.3.
- **Chart engine:** a small permissive layout (a d3-hierarchy-class tidy tree, one for ancestors and one for descendants) rendered as DOM or SVG buttons. That keeps every node focusable.

## 5. Data prerequisites (can start now)

### 5.1 Package and input contract

A new top-level package lives in the harrisonfamily repo at `graph/`, next to `api/`, `auth/` and `edge-gate/`:

```
graph/
  package.json            private, "type":"module", engines node>=22, exact pins: sharp (Apache-2.0); dev: ajv (MIT)
  bin/build-graph.mjs     CLI (see below)
  bin/fetch-gazetteer.mjs the ONLY network path (public GeoNames dump), §5.6
  src/source.mjs          RecordSource: JSONL file | stdin | gramps-copy (spawns sqlite3 -readonly) ; later: cloud (§5.7)
  src/project.mjs         allowlist projection (§5.2)
  src/generations.mjs     §5.4
  src/geocode.mjs         §5.6
  src/faces.mjs           §5.5 (MediaReader: staging dir | S3 later)
  src/verify.mjs          privacy + schema + size verification
  src/build.mjs           export function buildFamilyGraph(objects, opts) -> { graph, faceJobs, report }   (pure, no I/O)
  schema/family-graph.v1.schema.json   JSON Schema 2020-12, additionalProperties:false everywhere
  gazetteer.lock.json     sha256 + retrieval date of the 4 GeoNames files (no family data)
  test/                   node --test; synthetic fixtures only (invented names, as islands/tests do)
```

**Input.** The input is a stream of `_class`-tagged Gramps 6 JSON objects, one per line. This is exactly the `json_data` column of Gramps schema v21 and the JSON-addon line format that ARCH-C snapshots use (digest, sync map). The builder therefore runs unchanged on:
- **Interim:** `node graph/bin/build-graph.mjs --from-gramps-copy <copy>/sqlite.db ...`. This runs `sqlite3 -readonly "file:<db>?mode=ro"` with `SELECT json_data FROM person UNION ALL ... family, event, place, media` and streams the output over a pipe. Nothing is written to disk in between, so no unredacted JSONL ever lands in a file. If `<dbdir>/lock` exists, the builder refuses with `GRAMPS_OPEN`, the same rule as the sync addon.
- **Target:** `--snapshot <file|->` reads the cloud store's redacted snapshot. Once the sync domain exists, `viz-graph-cloud-source` (§5.7) adds the `cloud` source.

**Output flags.**
- `--out <staging>` writes `<staging>/person/graph.json` and `<staging>/media/faces/`.
- `--report <path>` writes the local report, by default `<project>/workspace-local/graph-build-report.json`. That path is outside the synced staging prefixes.
- `--verify-against <staging>/person` cross-checks the `living` flags against `person/*.json` `isLiving` (§5.2, rule L).
- `--verify <graph.json>` re-runs the privacy and schema checks on an already-written file, for example the published copy.

**Other rules.**
- Every write is atomic: write a temp file, then rename. A fatal error leaves the previous graph.json and faces untouched.
- `.gitignore` gains `graph/out/`, `graph/**/*.jsonl` and `*.gazetteer/` (D-03 hygiene). The repo holds only synthetic fixtures and the gazetteer lock.

### 5.2 Privacy projection (allowlist)

The projection reads only the fields in this table. Nothing else is copied: not notes, addresses, URLs, attributes, LDS ords or citations, and no free-text description. It is safe on unredacted input, and again on the cloud's redacted input.

| output | source (Gramps 6 JSON) | rule |
|---|---|---|
| `id` | `Person.gramps_id` | The site key: comments, person URLs, session sub. Handles are never emitted. |
| `name`, `given`, `surname` | `primary_name.first_name`; the primary entry of `surname_list` | `name` is "given surname", the same rule as `displayName` (transform.py), or `"unknown"`. No nick, call, title or suffix. |
| `sex` | `gender` | `f`, `m` or `u`. Gramps UNKNOWN and OTHER both become `u`, the same as the ETL. |
| `living` | rule **L** | **L:** while the ETL rule stands, `living = (death_ref_index == -1)`. If the privacy domain changes the rule, the record source must carry the precomputed classification, and the builder uses that. `--verify-against` fails with `LIVING_MISMATCH` (exit 5) if any `living` differs from `person/<id>.json` `isLiving`. The two can never disagree. |
| `birthYear`, `deathYear` | `event_ref_list[birth_ref_index / death_ref_index]` → `Event.date.dateval[2]` | **Year only.** `null` when the year is 0 or the date is text-only (Date MOD_TEXTONLY). `dateval[0..1]`, `sortval`, `text` and `newyear` are never read into the output. `deathYear` is always `null` when `living`. |
| `yearApprox` | `Date.modifier`, `Date.quality` | `true` if the modifier is not NONE or the quality is not REGULAR (constants from `gramps/gen/lib/date.py`). |
| `birthPlace`, `deathPlace` | `Event.place` → the settlement-level place (rule **S**) | A place `id` (Place.gramps_id). |
| unions and edges | `Family.father_handle`, `mother_handle`, `child_ref_list[].{ref,frel,mrel}`, `type` | §5.3. A custom family or child-ref type becomes `"custom"`, and its free-text string is dropped. |
| `events` (for the v2 layers) | person `event_ref_list` with role PRIMARY, FAMILY, BRIDE or GROOM; type in the allowlist (birth, death, burial, marriage, divorce, residence, education, graduation, degree, military_serv, emigration, immigration, occupation; anything else becomes `other`) | Each event is `{person, type, year, place}`. No description, day or month. **Residence events of living people are dropped by default** (VIZ-D5). |
| `places` | `Place.gramps_id`, `name.value`, `place_type`, `placeref_list[0]`, `lat`, `long` | Rule **S:** address-grade types (Street, Number, Building, Farm, Neighborhood) are never emitted. Events that use them collapse to the nearest enclosing place of locality type or above, with warning `ADDRESS_GRADE_PLACE_COLLAPSED` (none exist today). Coordinates are rounded to 2 decimal places, about 1.1 km. |
| `face` | `Person.media_list[0]` (`ref`, `rect`) → Media | §5.5. Only the person's primary photo, the one the hero already shows to every member. |

**Exclusions.**
- Any person, family, event, place or media object, or any reference to one, with `private: true` is excluded (`PRIVATE_EXCLUDED`). There are none today, and VIZ-D4 settles the rule.
- A person excluded this way also drops out of every union and edge.

**`verify()` checks.** `verify()` runs before every write and in `--verify` mode. Any failure gives `PRIVACY_VIOLATION` (exit 4), and nothing is written.
1. The output validates against `family-graph.v1.schema.json`, with `additionalProperties:false`. Years are integers in 1000..(the current year), so a Gramps sort value (a Julian day number of about 2.4 million) can never pass.
2. A deep string scan rejects any value that matches:
   - a day-precise date (`\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b`, ISO `\d{4}-\d{2}-\d{2}`, or month-name forms);
   - an e-mail address (`@`);
   - a phone number (7 or more digits with separators);
   - `https?://`.
   When the privacy domain's shared R-18 detector exists, the scan uses it.
3. All coordinates have at most 2 decimals.

### 5.3 graph.json v1 (exact shape)

S3 key: `person/graph.json`. The served path `/person/graph.json` is gated (§6). An example with invented data:

```json
{
  "schemaVersion": 1,
  "minor": 0,
  "generatedAt": "2026-10-20T18:04:00Z",
  "source": { "kind": "gramps-copy", "snapshot": "sha256:1a2b3c4d", "builder": "hfy-graph@0.1.0", "projection": 1 },
  "counts": { "people": 4, "unions": 1, "edges": 4, "places": 2, "events": 3, "components": 2, "faces": 1 },
  "people": [
    { "id": "I9001", "name": "Ada Example", "given": "Ada", "surname": "Example", "sex": "f", "living": false,
      "birthYear": 1880, "deathYear": 1950, "yearApprox": false, "birthPlace": "P9002", "deathPlace": null,
      "generation": 0, "component": 0, "face": "faces/I9001-9f8e7d6c.webp" },
    { "id": "I9002", "name": "Ben Example", "given": "Ben", "surname": "Example", "sex": "m", "living": false,
      "birthYear": 1878, "deathYear": null, "yearApprox": true, "birthPlace": null, "deathPlace": null,
      "generation": 0, "component": 0, "face": null },
    { "id": "I9003", "name": "Cleo Example", "given": "Cleo", "surname": "Example", "sex": "f", "living": true,
      "birthYear": 1990, "deathYear": null, "yearApprox": false, "birthPlace": "P9002", "deathPlace": null,
      "generation": 1, "component": 0, "face": null },
    { "id": "I9004", "name": "Dee Sample", "given": "Dee", "surname": "Sample", "sex": "u", "living": true,
      "birthYear": null, "deathYear": null, "yearApprox": false, "birthPlace": null, "deathPlace": null,
      "generation": null, "component": 1, "face": null }
  ],
  "unions": [
    { "id": "F9001", "type": "married", "partners": ["I9001", "I9002"],
      "children": [ { "id": "I9003", "rel": { "I9001": "birth", "I9002": "adopted" } } ] }
  ],
  "edges": [
    { "s": "I9001", "t": "I9002", "kind": "partner", "union": "F9001", "type": "married" },
    { "s": "I9001", "t": "I9003", "kind": "parent", "union": "F9001", "rel": "birth" },
    { "s": "I9002", "t": "I9003", "kind": "parent", "union": "F9001", "rel": "adopted" }
  ],
  "places": [
    { "id": "P9001", "name": "Examplestate", "type": "state", "parent": null, "lat": null, "lon": null, "geo": null },
    { "id": "P9002", "name": "Riverton", "type": "city", "parent": "P9001", "lat": 40.00, "lon": -100.00, "geo": "geonames" }
  ],
  "events": [
    { "person": "I9001", "type": "birth", "year": 1880, "place": "P9002" },
    { "person": "I9001", "type": "death", "year": 1950, "place": null },
    { "person": "I9003", "type": "graduation", "year": 2012, "place": "P9002" }
  ],
  "components": [ { "id": 0, "size": 3, "roots": ["I9001", "I9002"] }, { "id": 1, "size": 1, "roots": ["I9004"] } ],
  "generations": [ { "component": 0, "levels": [ ["I9002", "I9001"], ["I9003"] ] } ],
  "attribution": { "geonames": true }
}
```

**Vocabularies:**
- `unions[].type`: `married | unmarried | civil_union | unknown | custom`, from Gramps FamilyRelType.
- `rel`: `birth | adopted | step | sponsored | foster | unknown | none | custom`, from ChildRefType.
- `edges[].kind`: `partner | parent`.

**How unions and edges relate.**
- `unions` is canonical. It carries 0 to 2 partners, so mother-only families and parentless sibling groups need no special cases.
- `edges` is derived from it for generic graph libraries.
- A test asserts the two agree.
- `rel` is keyed by parent id because Gramps records `frel` and `mrel` separately.

**Ordering and compatibility.**
- Every array is ordered by gramps_id (levels by `(birthYear ?? 9999, id)`).
- Keys are written sorted.
- The same input gives a byte-identical file.
- The client accepts `schemaVersion === 1` with any `minor`. Additive fields bump `minor`; a breaking change bumps `schemaVersion` and needs a client released first.

**Size estimates.**
- About 230 bytes raw per person, including edges and events: at 231 people, about 55 KB raw and about 12 KB gzip.
- At 2,000 people: about 470 KB raw and about 90 KB gzip.
- The budget is in §11.

### 5.4 Generation index

`computeGenerations(people, unions)` in `graph/src/generations.mjs` is pure and deterministic:

1. **Components.** Find the connected components over partner and parent links. Ids are assigned by size descending, ties broken by the smallest gramps_id, so component 0 is the main tree (221 people today).
2. **Parent DAG.** Every child ref counts, whatever its `rel`, because a step-child still sits one generation down.
3. **Cycles.** Run a Kahn topological sort. Any nodes left over form a cycle, which is a data error. Those nodes get `generation: null` and warning `GRAPH_CYCLE` with their ids, in the local report only. The run never hangs.
4. **Longest path.** In topological order, `g(v) = 0` if v has no parents, otherwise `1 + max(g(parent))`. Pedigree collapse is handled for free: it is a DAG, so no one is duplicated.
5. **Partner alignment.** This handles married-in spouses. Repeat until nothing changes, with at most |people| rounds:
   - A partner with **no parents in the graph** takes `max(g(partner))` over all its unions, then its descendants are re-propagated.
   - Values only increase and are bounded, so the loop terminates.
   - Two partners who both have parents keep their own values. A cross-generation marriage is legitimate and is not flagged.
6. **Normalize.** Shift each component so its minimum generation is 0, where 0 is the oldest.
7. **Index.** `generations[]` holds the levels for each component. Singletons are their own components at generation 0, and the client shows them as "not yet connected" (§9.4) and never compares generations across components.

The client derives relative labels, so absolute numbers never appear in the UI: `rel = g(x) − g(focus)` gives "your grandparents' generation" for −2. Expected today: component 0 has 8 levels (0..7), matching the 8-person chain.

### 5.5 Face crops from tagged regions

`graph/src/faces.mjs` uses sharp (Apache-2.0, exact pin), on io's Mac now and in the cloud renderer later.

**Source.**
- The source is `Person.media_list[0]`, which is Gramps' person image and the same image `primaryPhoto` uses.
- Bytes come from a `MediaReader`:
  - interim: the ETL staging `media/<handle>.<ext>`, matched by glob with `.json` excluded;
  - later: S3 `media/<handle><ext>`.

**Crop rule.** This keeps parity with Gramps thumbnails (digest photo-tag gap fill, `imagethumb.py:71-80`):
1. Take `rect = [x1,y1,x2,y2]`, integer percent. Order the corners with min/max and clamp them to 0..100. An invalid or zero-area rect is treated as `null`, with warning `RECT_INVALID`.
2. Convert to pixels by truncation, measured on the **stored pixels**: `left = floor(x1/100*W)` and likewise for the other edges. **No EXIF auto-orient before the crop**, because Gramps measures its rect on unrotated pixels. If a source has Orientation ≠ 1, the builder warns `ORIENTATION_NOT_BAKED` (none do today; the promotion rule in the photo-tags domain bakes the orientation in).
3. Expand the box to a square around its centre, clamped to the image. When `rect` is `null`, use the centre square of the whole image.
4. Resize to 160×160 with cover, encode WebP at quality about 70, and strip all metadata. Target: 8 KB or less.

**Naming and caching.**
- Each file is named `faces/<gramps_id>-<sha8>.webp`, where `sha8` is the first 8 hex digits of `sha256(source bytes ‖ JSON(rect))`.
- A changed photo or rect therefore gets a new URL. This matters because gated responses are `no-store`, so a stale in-memory image can never show the wrong face.
- An unchanged input writes nothing.
- Faces no longer referenced are removed from the output directory, so the `--delete` sync removes them from S3.

**Failures.** None of these fail the build. The node gets `face: null` and the UI shows initials.

| code | condition |
|---|---|
| `PLACEHOLDER_MEDIA` | the source is 0 bytes (a Dropbox placeholder) |
| `MEDIA_MISSING` | the file is absent |
| `UNSUPPORTED_FORMAT` | HEIC with HEVC compression, which the prebuilt sharp binaries cannot decode, or any decode error |

### 5.6 Place geocoding, offline and at build time

**Rule:** geocoding uses place names only, matched locally. No person data and no place name leaves the machine.

*Amended by the viz ADR (DOC-A4FBA13AE98A, section 7; BRD2 section 11.6; VIZ-D6), approved by io on 2026-10-13.*

**5.6.1 Precedence.** Coordinates are taken in this order:
1. Gramps `lat`/`long`, if they parse (`geo: "gramps"`). Decimal and simple DMS are parsed; anything else gives warning `COORD_UNPARSEABLE` and falls through to step 2.
2. io's reviewed coordinates from `places.geo.json` (5.6.4), which are GeoNames-derived (`geo: "geonames"`).
3. The offline GeoNames match (`geo: "geonames"`).
4. For a state, province or country place, a centroid (`geo: "naturalearth"`, 5.6.3 step 4). The schema's `minor` 1 adds that value.
5. Otherwise `null`.

**5.6.2 Gazetteer.**
- **Files.**
  - GeoNames public dumps under CC BY 4.0: `cities1000.zip` (replacing `cities500.zip`), `admin1CodesASCII.txt`, `admin2Codes.txt` and `countryInfo.txt`.
  - Centroids for state, province and country places: the Natural Earth admin-0 and admin-1 files (`ne_10m_admin_0_countries.zip`, `ne_10m_admin_1_states_provinces.zip`, public domain), or the Census State Gazetteer. `admin1CodesASCII.txt` has no coordinates.
- **Fetching.** `graph/bin/fetch-gazetteer.mjs` fetches them once into `$HFY_GAZETTEER_DIR` (default `~/Library/Caches/hfy-gazetteer`, outside the repo and Dropbox). It records each file's sha256, size and retrieval date in `graph/gazetteer.lock.json`. A bulk download of a public file reveals nothing about the family.
- **Local files next to the cache, never in Git.**
  - `overrides.json`, the override table, holds place names only (5.6.3).
  - `places.geo.json` holds io's reviewed coordinates (5.6.4).
- **Checksums.** A later checksum mismatch fails with `GAZETTEER_CHECKSUM` unless `--update` is passed, which re-pins.
- **Missing files.** If the files are missing, the build continues with Gramps coordinates only (`GAZETTEER_MISSING`).
- **No network during builds.** A build never touches the network. A test blocks `fetch`, `http` and `https` and still passes.

**5.6.3 Matching.** For each place that an event uses, or that has no children:
1. Walk its parent chain. The country is matched first, by name or ISO code in `countryInfo`. Each ancestor below it is accepted as a parent at **admin1 or admin2** of that country, using accent- and case-folded `name`, `asciiname` and alternate names. This handles a "Province" that is really an admin2 département, and a city placed directly under its country.
2. Candidates are the `cities1000` rows of class P whose name, ASCII name **or alternate name** matches, and whose country, admin1 and admin2 match wherever those are known.
3. The candidate with the highest population wins. If the top two are within 2× of each other, the result is `AMBIGUOUS_PLACE` and the place is left unresolved. No match at all gives `UNRESOLVED_PLACE`.
4. State, province and country places take their centroid from Natural Earth or the Census Gazetteer (`geo: "naturalearth"`), because `admin1CodesASCII` has no coordinates. A county or other admin2 area gets no point, and a map fits to its child points instead.
5. **The override table** (`overrides.json`) handles what folding cannot: a region that GeoNames files at admin2, a city known by another name (a `geonameId`), or another spelling to search.
6. The report records each resolved place's `geonameId`, its population and any runner-up, for io's review. The report is local and never synced.

Expected today: all 23 leaf places resolve. The names that could be ambiguous are disambiguated by their parent place (digest gap-fill §5).

**5.6.4 Long term (VIZ-D6).**
- The 23 resolved coordinates are a reviewable list. io writes the reviewed coordinates back into Gramps (lat/long) once, or approves a reviewed `places.geo.json` kept outside the repo.
- From then on the coordinates live in the source of truth, sync to the cloud store, and the cloud renderer (§5.7) needs no gazetteer, because Lambda reads stored lat/long only.
- **The credit.** Every surface that shows a coordinate shows "Place coordinates: GeoNames (geonames.org), CC BY 4.0, modified", with its licence link, whenever `attribution.geonames` is true. The text is `GEONAMES_CREDIT` in `graph/src/geocode.mjs`.

### 5.7 Publishing

**Interim** (`viz-graph-publish`): a new runbook step in `docs/how-to/refresh-the-family-data.md`, **2b. Graph**. It runs after step 2 (Trees) and before step 3 (Search):

```sh
node <repo>/graph/bin/build-graph.mjs --from-gramps-copy "$HFY_GRAMPS_DB" \
  --out <project>/workspace-local/harrisonfamily-frontend --verify-against <project>/workspace-local/harrisonfamily-frontend/person
```

- Step 4, `sync_to_s3.py`, already syncs `person/` and `media/`, so `person/graph.json` and `media/faces/` publish with no script change.
- The site deploy already excludes `person/*.json` and `media/*` (`ci.manifest.yaml:21-29`).
- Real runs are io's step, sent as a handoff per HFY-R10 because they need io's go-ahead for the sync.

**Target** (`viz-graph-cloud-source`, W6): when the sync domain's cloud store becomes the source of truth (R-03), the component that renders `person/*.json` from it calls `buildFamilyGraph()`:
- It runs after each applied change batch, debounced.
- It uses the `cloud` RecordSource and an S3 `MediaReader`.
- It writes `person/graph.json` and the changed faces, and runs `verify()` first.
- A failure keeps the previous graph and raises an operator alert, using whatever alerting the renderer has.
- No gazetteer runs in Lambda (§5.6.4).

## 6. Data model

There are no DynamoDB items. The domain adds only S3 objects under prefixes that are already gated, which means:
- no new CloudFront behavior;
- no change to `add-data-gate-behaviors.sh:46` PATTERNS or to `append-index.js:20` DENY_FIRST_SEGMENTS;
- no IAM change;
- no `ci.manifest.yaml` exclude change.

| key | producer | served as | gate and cache |
|---|---|---|---|
| `s3://harrisonfamily-frontend/person/graph.json` | graph builder (§5.7) | `GET /person/graph.json` | `/person/*.json` behavior + `hfy-edge-gate`, CachingDisabled, `private, no-store`. Variant probes on the default behavior get 404 from HFYAppendIndex ("any .json under /person/"). |
| `s3://harrisonfamily-frontend/media/faces/<gramps_id>-<sha8>.webp` | graph builder (§5.5) | `GET /media/faces/...` | `/media/*` behavior + gate, `private, no-store` |
| *(v2, only if the ADR picks raster tiles)* `tiles/<basemap>.pmtiles` | io upload, a separate prefix outside every `--delete` sync | `GET /tiles/...` (HTTP range) | Public map data with no family content. It needs a new behavior and io gate, so it is not part of the MVP. |

**Local only, never synced or committed:**
- `<project>/workspace-local/graph-build-report.json` (warnings with ids and names, for io);
- `$HFY_GAZETTEER_DIR/*`.

**Repo:** `graph/gazetteer.lock.json`, which holds only checksums.

**Browser:**
- URL state `?focus=<gramps_id>&view=outline|chart`;
- `localStorage["hfy:tree-view"]` remembers the last view for each viewer, wrapped in try/catch;
- no service-worker caching of gated data (`11ty/sw.js:1`, offline shell only).

## 7. APIs

**No new routes.** The graph is a gated static object, for these reasons:
- It is the same pattern as `person/index.json`.
- It adds no Lambda cost and no `/api` CSRF or 415 surface.
- It needs no MCP policy row.

The static resource contract the island relies on:

| request | response | island behavior |
|---|---|---|
| `GET /person/graph.json` with a valid `io_id` | 200 `application/json` (graph v1), `Cache-Control: private, no-store` | render |
| same, session expired | 401 JSON from the gate | `dataFetch` refreshes and retries once (HFY-R66), then sends the visitor to the sign-in with `returnTo=/tree/?...` |
| graph not yet published | 403 or 404 from the S3 origin | empty state "the family tree is being prepared" |
| `schemaVersion` ≠ 1, or malformed JSON | 200 with a bad body | error state with a retry button; `console.error` gives the code |
| `GET /media/faces/<f>` | 200 `image/webp`, or 401/403/404 | initials avatar on any non-200 |

The page URL contract:
- `/tree/` focuses the viewer's own person.
- `/tree/?focus=<gramps-id>` focuses that person.
- `&view=outline` or `&view=chart` picks the view.
- An unknown `focus` triggers the fallback rule in §9.4.

## 8. Client architecture

**The page.**
- `11ty/tree/index.html` is repo-owned, like `/private/`, and mirrored to the Dropbox Eleventy `src` per HFY-R46.
- Its markup is `main.hfy-page > h1 "family" > div[data-island=tree] > noscript`. The noscript text says that the tree needs JavaScript and that people can be found through search.
- It is added to `islands/heads.mjs:21-35` PAGES, `copy.mjs` COPY_EXTRA and the `11ty/README.md` repo-owned list.

**The loader.**
- In `11ty/js/feature-flags.js` it runs next to `:762-799`: `if (flags.familyViz === true && /^\/tree\/?(index\.html)?$/.test(path)) loadIsland("tree")`.
- The CSS loads first (`loadIsland`, `:711-747`).
- The island source is `islands/src/islands/tree.jsx`; the build auto-discovers it (`build.mjs:54`), and it is listed in `bundle.test.mjs`.

**Modules.**
- **`islands/src/lib/family-graph.js`** is pure and unit-tested in node. It provides:
  - `parseGraph(json)`, which checks the version;
  - `class FamilyGraph`, with `person(id)`, `parents(id)` returning `[{id, rel}]`, `unionsOf(id)` returning `[{union, partner, children:[{id, rel}]}]`, `siblings(id)` returning `[{id, half}]`, `grandparents(id)`, `relativeGeneration(a, b)`, `neighborhood(id, {up, down})` returning `{nodes, edges}`, and `levels(component)`;
  - `relationLabel(viewer, other)`, a small kinship namer used by the focus card and by v2.
- **`islands/src/islands/tree.jsx`:**
  - `TreeApp` owns the focus state. It keeps `?focus` in sync with `history.pushState`, and back/forward restores the previous focus.
  - `FocusNavigator` and `GenerationOutline` (§12.3) always render.
  - `ChartView` is `React.lazy(() => import("../lib/tree-chart.jsx"))`. It holds the research-chosen visual in its own chunk.
  - v2 layers are separate lazy chunks behind their flags.
- **`islands/src/tree.css`** uses tokens only (theme-lint). Role colours reuse the `--io-color-semantic-tree-*` pairs (focus, parent, grandparent, sibling, spouse, child, grandchild, each with `-ink`), which HFY-R72 contrast-fixed.

## 9. UX

**Voice and labels.**
- The voice is the DS lowercase voice, as in the shell labels.
- Relationship words are plain: mother, father, parent; wife, husband, spouse (married union) or partner (other unions); daughter, son, child; sister, brother, sibling, with a "half-" prefix for half-siblings and "step"/"adopted" from `rel`.
- They come from `relationLabel`, never from colour alone.

### 9.1 Desktop (64rem and wider, within the shell column)

```
+----------------------------------------------------------------------------------------------+
| [shell bar: home  FAMILY  search  posts  me ...]                                              |
| family                                                     [ chart | outline ]  (?) about this |
+--------------------+---------------------------------------------------+---------------------+
| generations        |                (ChartView: research-chosen)        |  [face]             |
|  > great-grand...  |      gp   gp        gp   gp                        |  Ada Example        |
|  > grandparents'   |        \  /           \  /                         |  1880 - 1950        |
|  v parents' gen.   |       parent ===== parent        (partners beside) |  born in Riverton   |
|     Ben Example    |              |                                     |  2 parents          |
|     ...            |     sib  [ FOCUS ] === spouse                      |  1 spouse, 3 kids   |
|  > your gen.       |              |                                     |  [ view page ]      |
|  > not yet         |      child  child  child                           |  how you're related:|
|    connected (10)  |                                                    |  great-grandmother  |
+--------------------+---------------------------------------------------+---------------------+
```

- **Left:** the generation outline, a 280 px token column.
- **Centre:** the chart, which gets most of the space.
- **Right:** the detail panel.
- Clicking any node or outline entry re-centres. "view page" opens `/person/?id=`.
- The chart never renders a name below 16 CSS px. Dense levels collapse to "+N more" chips instead of shrinking (semantic zoom).
- v2 adds a layer switch: `people | places | time`.

### 9.2 Medium (43rem to 64rem)

- Two columns: the chart and the detail panel.
- The outline opens from a "generations" button as a kit `Sheet` (right side), the same pattern as the account sheet (`shell.jsx:151`).

### 9.3 375 px phone: the focus navigator, a first-class primary view

```
+-------------------------------+
| family          [chart|outline]|
| +---------------------------+ |
| | (face) Ada Example        | |  <- sticky focus card
| | 1880 - 1950 · Riverton    | |
| | [ view page ]  [generations]| |
| +---------------------------+ |
| parents                        |
| (o) Ben Example     father  >  |  <- 44 px+ rows, tap = re-centre
| (o) Cara Example    mother  >  |
| spouse and children            |
|  with Dan Example (husband) >  |
|   (o) Eve Example  daughter >  |
|   (o) Fay Example  son      >  |
| brothers and sisters           |
| (o) Gus Example  half-brother> |
| grandparents  (4)          v   |  <- collapsed by default
| [ <- back to Ben Example ]     |
+-------------------------------+
| home family search posts me    |  <- shell bottom bar
+-------------------------------+
```

- **No pinch-and-pan canvas.** Each tap re-centres, and the browser's back button steps back.
- **Generations.** The "generations" button opens the outline in a bottom `Sheet`.
- **The chart toggle.** It appears on phones only if the ADR's chosen visual is phone-native. Otherwise the phone always shows the navigator.

### 9.4 States and sparse data

| situation | what the page does |
|---|---|
| no photo (205 of 231 people) | Initials avatar in the role colour pair; the face image has `alt=""`. |
| unknown years | "years unknown". `yearApprox` shows "about 1880", in words, never as a styling cue only. |
| no parents recorded (60 people) | "parents not recorded yet". If R-24's flag is on, it adds a link: "know who they are? suggest a relationship". |
| disconnected (10 people) | The outline's last group is "not yet connected to the tree (N)". |
| focus id unknown, or the viewer is not in the graph | Focus falls to the viewer's own id. If that is absent too, it goes to the generation-0 person of component 0 with the most descendants, and a polite notice explains why. |
| offline | The shell's offline line plus "the family tree needs a connection". |
| loading | A skeleton focus card with `aria-busy`. |

## 10. Nav: how `/tree/` becomes the family tab

**Today:**
- `NAV` family points to `/private/` (`islands/src/islands/shell.jsx:19-25`).
- With a session, `Shell()` remaps it to `ownRoute(sub)` (`:178`).
- `/private/` redirects through `HFYFeatureFlags.goToFamily()` (`11ty/js/feature-flags.js:621-639`).
- The family tab is marked current only on the member's own page (`islands/src/lib/family-route.js:5-12`).

**With `familyViz` on, the change in `viz-page-shell` is:**
1. **The family route.** `Shell()` remaps `family` to `/tree/`, in the same pattern as the `notifyV2` remap at `shell.jsx:178`. There is no sub swap. The static `NAV` constant keeps `/private/`, so the registry assertion in `family-route.test.mjs:46-51` still holds and the gated-prefix guard still passes, since `/tree/` is not a data prefix.
2. **The current tab.** `family` is current on `/tree/` and its sub-paths. A person page reached from the tree still marks no tab (the R74 rule for other people's pages is unchanged).
3. **The redirect.** `familyUrl()` returns `/tree/` for everyone, signed in or not. The `/tree/` page shell is public and static; its data fetch 401 sends signed-out visitors to the sign-in and back to `/tree/`. So `/private/` and old bookmarks land on the tree.
4. **The person page.** `person-page.js` adds a "see in the family tree" link to `/tree/?focus=<id>` in `#person-family-section` (`11ty/person/index.html:153-159`), shown only when `familyViz` is on. The Graphviz frame stays until v2 (`viz-v2-retire-graphviz`).
5. **The icon.** The family tab icon stays a `currentColor` mask (`islands/src/shell.css:296-326`). A tree glyph is optional and local to HFY.

**Coordination with R-20 (nav domain).** R-20 moves the own page to "me" and the gear to settings.
- **The problem:** if R-20 flips before `familyViz`, "family" and "me" both open the own page.
- **The fix (VIZ-D7):** ship the `familyViz` flip in the same release group as the R-20 nav flip.
- **The fallback:** if R-20 must ship first, the nav domain keeps "family" on the own page until `familyViz` flips, and the worklog records the interim duplication.

## 11. Performance budgets

**How they are measured.**
- Playwright Chromium against the built `11ty/` served by `http-server`, the existing devDependency.
- Hermetic route stubs, as in `islands/tests/d11-fixes.spec.mjs`.
- Synthetic graphs of 231 and 2,000 people from a deterministic generator (`islands/tests/fixtures/graph-synth.mjs`, invented names).
- CDP `Emulation.setCPUThrottlingRate(4)` and a network profile of about 1.6 Mbps with 150 ms RTT (the Lighthouse "slow 4G" class).

**The ADR's budget changes.** The viz ADR (DOC-A4FBA13AE98A, section 5) changed these budgets, and io approved them with Q2-13 on 2026-10-13 (BRD2 section 11.6):
- **The navigator.** The 120 KB chart chunk becomes the navigator chunk: at most 35 KB gzip of JS and 15 KB gzip of CSS.
- **The map.** The 250 KB v2 places chunk is removed. It is replaced by the v3 map: maplibre-gl 6.14.0 is about 431 KB gzip (287 KB main plus a 144 KB worker) plus 10.5 KB of CSS, loaded only on the map view.
- **New ceilings.** The table adds ceilings for the v2 chunks, the build-time layout and the basemap file.
- **Changes.** A miss fails the test that enforces it. Changing a number needs an amendment to the ADR, approved by io.

| budget | 231 people | 2,000 people | enforced by |
|---|---|---|---|
| `person/graph.json` gzip, including the additive `layout` and `photoEdges` blocks | ≤ 25 KB | ≤ 150 KB | the "size at 2,000 people" test in `graph/test/build.test.mjs`; builder exits 3 (`SIZE_BUDGET`) over 150 KB gzip. A miss is remedied by an ADR amendment (for example a separate gated layout file), never by a silent budget change. |
| tree island entry + its own chunks, gzip, excluding the shared React chunk the shell already loads | ≤ 60 KB | same | `islands/tests/tree-budget.test.mjs`: follows static imports from `11ty/js/islands/tree.js` and subtracts chunks `shell.js` also imports |
| navigator chunk (lazy; Concept A, `<family-navigator>`), gzip | ≤ 35 KB JS and ≤ 15 KB CSS | same | same test (the old 120 KB chart-chunk line is removed) |
| v3 Journeys chunk set (lazy, only when the map view opens): maplibre-gl 6.14.0 main and worker (about 431 KB), pmtiles (about 8 KB), @protomaps/basemaps (about 6.8 KB) and our code, gzip | ≤ 460 KB JS and ≤ 12 KB CSS (MapLibre CSS about 10.5 KB); 0 bytes on `/tree/` before the map opens | same | same test, plus a network test that the map view alone fetches it |
| v2 lifelines chunk (lazy), gzip | ≤ 25 KB JS and ≤ 5 KB CSS | same | same test |
| v2 faces tab chunk (lazy), gzip | ≤ 15 KB JS and ≤ 5 KB CSS | same | same test |
| v2 poster chunk (lazy), gzip | ≤ 30 KB JS and ≤ 5 KB CSS; no d3-dag module | same | same test; the bundle test lists no d3-dag module |
| v2 kinship UI chunk (lazy), gzip | ≤ 10 KB JS | same | same test |
| time from navigation to a visible focus card (LCP proxy), cold, throttled | ≤ 2.5 s | ≤ 3.5 s | `islands/tests/tree-perf.spec.mjs`. The card renders from the fetched, gated graph: no data inlined into the page, no service-worker cache. |
| re-centre: longest main-thread task (PerformanceObserver `longtask`) | ≤ 100 ms | ≤ 200 ms | same |
| CLS on load | ≤ 0.05 | ≤ 0.05 | same (layout-shift entries) |
| face requests in the first view | ≤ 24, lazy via IntersectionObserver, each ≤ 8 KB | same | perf spec counts requests; `graph/test/faces.test.mjs` checks the size |
| generation compute (builder, Node 22) | — | ≤ 200 ms | `graph/test/generations.test.mjs` |
| poster layout compute (builder; d3-dag 1.2.2 `coordGreedy`) | ≤ 5 s, checked everywhere, CI included | ≤ 60 s, checked only where `HFY_GRAPH_PERF=1` (the worker and io's machine), never on shared CI runners | the graph suite's layout-time tests (`viz-graph-v2-layout`); the ADR measured 1.09 s and 12.9 s at most, on Node 24 |
| basemap file (v3, `map/*.pmtiles`) | ≤ 512 MB per file (the maxzoom-11 extract is about 0.29 GB) | same | `viz-v3-basemap` records the extract's size; Cloudflare caches no file over 512 MB |

Gated responses are `no-store` (HFY-R65), so the graph and faces are fetched again on every visit. That is why they are kept small, and why the ruling is not loosened.

## 12. Accessibility budgets and the outline alternative

### 12.1 Budgets (D-11 plus WCAG 2.2 AA), enforced in `islands/tests/tree.spec.mjs`

- **axe.** Zero serious or critical violations at 375 and 1280 px, in outline view and in chart view. This uses `@axe-core/playwright` as a devDependency with an exact pin; it is MPL-2.0, test tooling only, and the licence is flagged in the PR.
- **Targets.** Every interactive target is at least 44×44 CSS px (D-11).
- **Text.** Names are at least 16 CSS px, in the chart too (the `TREE_LABEL_FLOOR` precedent).
- **Reflow.** No horizontal page scroll at 320 or 375 px; the chart may pan inside its own region, but the page never scrolls sideways (D-11, WCAG 1.4.10).
- **Contrast.** Text is at least 4.5:1. Edges, focus rings and node borders are at least 3:1. This reuses the compositing `CONTRAST` helper from `d11-fixes.spec.mjs`.
- **Keyboard.** A keyboard-only run can re-centre three times, step back with the browser history, and open a person page. Focus is always visible, and focus moves to the new focus card's heading after a re-centre.
- **Announcements.** A screen reader hears each new focus through one polite live region: "centred on Ada Example: 2 parents, 1 spouse, 3 children".
- **Reduced motion.** With `prefers-reduced-motion: reduce` there are no animated transitions; re-centring is instant.
- **Gestures.** No path requires a gesture. Every drag or pinch in the chart has a button or outline equivalent (WCAG 2.5.1, 2.5.7). There are no single-character shortcuts (WCAG 2.1.4).

### 12.2 The chart's role

The chart is a supplementary view:
- **Labelling.** It is a labelled region, with "family chart centred on X. The outline has the same information." A skip link, "skip to the family outline", comes before it.
- **DOM nodes.** If the chosen library renders DOM or SVG nodes, each node is a `<button>` with an accessible name of the form "Ben Example, father, 1878 to unknown".
- **Canvas.** If it renders canvas, the canvas is `aria-hidden`, and the outline is the keyboard and screen-reader path.

### 12.3 The outline and focus navigator (always rendered; works without the chart chunk)

**Structure.**
- A focus `<section aria-labelledby>` with an `<h2>` holding the name, the years, the birthplace and a "view page" link.
- Below it, relationship groups. Each is an `<h3>` followed by a `<ul>` of `<button>`s that re-centre:
  - parents;
  - spouse/partner and children, grouped by union;
  - brothers and sisters;
  - grandparents.
- `<nav aria-label="generations">` holds one native `<details><summary>` per level, with relative labels.
- Large levels show 20 people, then a "show N more" button.
- The last group is "not yet connected".

**Other rules.**
- The outline is the only place that lists the whole tree, so screen-reader users get the full data set with no canvas.
- It is plain semantic HTML: no ARIA tree widget, no roving tabindex.

## 13. Kit changes

- **No new io-kit package (VIZ-D10).** The viz is specific to genealogy and has one consumer. Q-3 puts convergence at contracts, and nothing here is a cross-stack contract.
- **@io-kit/tokens (`iokit-tokens-viz`, conditional).** This happens only if the ADR's chart needs semantic tokens that the DS lacks: union and edge lines, the focus ring on nodes, era bands, map land, water and points.
  - The task adds them to the `harrisonfamily` theme in dark and light, with at least 3:1 non-text contrast, as a changeset patch.
  - io approves the DS amendment (the HFY-R72 precedent).
  - The HFY pin bump happens inside `viz-mvp-visual`, never in the kit task.
  - If the intake finds the existing `tree-*` pairs sufficient, the task closes as not needed.
- **@io-kit/shell (0.6.6 pinned):** no change. `Sheet` and `useBreakpoint` already exist and are used.

## 14. Flags

| flag | default | gates | dependencies |
|---|---|---|---|
| `familyViz` | `false` in `11ty/_data/flags.json` (mirrored to Dropbox per HFY-R70) | the `/tree/` island; the family tab remap and the `/private/` → `/tree/` redirect; the person-page "see in the family tree" link | The nav remap needs `shellV2`. Without it the page still works by direct link. The data fetch uses the authV2 session. |
| `familyVizTime` | `false` | v2 C-lite lifelines (time layer) | `familyViz` |
| `familyVizKinship` | `false` | v2 "how are we related" panel | `familyViz` |
| `familyVizFaces` | `false` | v2 Faces: "pictured with" chips and the faces tab on `/tree/` | `familyViz`; the published graph's `photoEdges` |
| `familyVizBigTree` | `false` | v2 desktop big-tree poster (64rem and wider) | `familyViz`; the published graph's `layout` block |
| `familyVizPersonMini` | `false` | v2: the person page shows a mini focus view instead of the Graphviz frame | `familyViz` |
| `familyVizJourneys` | `false` | v3 Journeys map (replaces `familyVizPlaces`; there is no v2 places layer) | `familyViz`; the `map/` basemap (G-map) and the CSP `worker-src 'self'` |

`familyVizPlaces` is retired: it becomes `familyVizJourneys` in v3 (BRD2 section 11.6). `familyVizFaces` and `familyVizBigTree` are new in v2. Each v2 and v3 flag flips on its own, after its own D-11 audit and io approval (`viz-v2-flips`, `viz-v3-flip`).

Preview and UAT on prod use `?hfy_flags=familyViz` (session-scoped, with the preview banner; HFY-R42 and HFY-R58).

## 15. Testing

- **Builder (`graph/`, `node --test`):**
  - projection allowlist and privacy scan (§5.2), with a fixture full of forbidden data;
  - golden graph for the messy-genealogy fixture: two partner families, a mother-only union, parentless siblings, every `rel` value, a private person;
  - generations, with all the fixtures from §5.4;
  - faces, on synthetic images including Orientation=6, 0-byte, HEIC and inverted rects;
  - geocode, with a mini gazetteer fixture and the network blocked;
  - determinism: shuffled input gives byte-identical output;
  - size at 2,000 people;
  - `--verify` and the exit codes.
- **Client logic (node):** `family-graph.js` queries, relative generations, `relationLabel`. v2 adds a table of 30 kinship cases.
- **E2E (Playwright, hermetic):** `tree.spec.mjs` covers:
  - states (loading, 401 to sign-in, 403/404 to the empty state, bad schema);
  - focus from the session and from `?focus=`, plus the fallback;
  - re-centre and history;
  - the outline;
  - the §12.1 accessibility budget;
  - 375, 768 and 1280 px.
  `family-route.test.mjs` and `shell.spec.mjs` cover the nav with the flag on and off; `person-page.spec.mjs` covers the link only when the flag is on.
- **Performance:** `tree-perf.spec.mjs` and `tree-budget.test.mjs` (§11).
- **Privacy on real output (io's machine):** `build-graph.mjs --verify` on the staged file before every sync, and on the published copy after it.
- **Live probes after deploy:**
  - signed out, `curl -sI https://harrisonfamily.us/person/graph.json` returns 401 with `private, no-store`;
  - signed out, `/tree/` returns 200 (the static page);
  - a signed-in fetch returns 200 with `schemaVersion: 1`.
- **D-11 audit:** an after-state audit doc with screenshots (375 installed iPhone PWA, 768, 1280), stored per HFY-R16.

## 16. Rollout

1. **W1, data prerequisites:** the builder, generations, faces and geocoding merge as code. There is no site change and no user impact.
2. **W2, publish:** io runs the build in the refresh runbook through a handoff, and graph.json and faces publish behind the gate. Nothing reads them yet. The live probes in §15 are the evidence.
3. **W0, in parallel:** the research intake produces an ADR, and io approves it (VIZ-D1). The UI tasks start only after that.
4. **W3–W4, MVP:** page shell, outline and navigator, then the chart. Everything deploys with `familyViz` off. io runs UAT on prod with `?hfy_flags=familyViz`.
5. **W4–W5, flip:** the D-11 audit, then io approval (G-prod), then the flags deploy first and the Dropbox flags sync (HFY-R70). This should be in the same release group as the R-20 nav flip. There is no data step at flip time, because the graph is already live behind the gate.
6. **W5–W6, v2:** each layer goes behind its own flag, with its own D-11 audit and io approval.
   - Graphviz retires last (`familyVizPersonMini`), after its flip. A handoff to io then drops `build_family_tree_media.py` from the runbook; the next `--delete` sync removes `media/tree_*.svg`.
   - `viz-graph-cloud-source` lands when the sync domain's renderer exists.

**Rollback:** turn the flag off, by redeploying flags.json or with a per-browser `-familyViz`. graph.json and faces are harmless while unused and can stay. A bad graph is replaced by re-running the build, because the atomic write keeps the last good file.

## 17. Error-handling catalog

| code | where | trigger | behavior | operator / user sees |
|---|---|---|---|---|
| `INPUT_MISSING` (exit 2) | builder | no source, unreadable DB or snapshot | nothing written | CLI message with usage |
| `GRAMPS_OPEN` (exit 6) | builder, gramps-copy source | `<dbdir>/lock` exists | refuse | "close Gramps or copy the tree first" |
| `SNAPSHOT_SHAPE` (exit 7) | builder | unknown `_class`, missing core fields, header schema ≠ 21 | nothing written | message naming the class or field (no values) |
| `PRIVACY_VIOLATION` (exit 4) | `verify()` | schema or pattern failure (§5.2) | nothing written; the previous file is kept | JSON pointer of the offending field (no value) |
| `LIVING_MISMATCH` (exit 5) | `--verify-against` | graph `living` ≠ person JSON `isLiving` | nothing written | list of gramps_ids |
| `SIZE_BUDGET` (exit 3) | builder | graph gzip > 150 KB | nothing written | actual size against the budget |
| `GAZETTEER_CHECKSUM` (exit 8) | geocode | cached file sha256 ≠ lock | geocode step fails; the build stops | "re-run fetch-gazetteer --update after review" |
| `GAZETTEER_MISSING` | geocode | no cache directory | Gramps coordinates only | report warning |
| `UNRESOLVED_PLACE` / `AMBIGUOUS_PLACE` | geocode | no candidate, or the top two within 2× | `lat/lon: null` | report list (local) |
| `COORD_UNPARSEABLE` | geocode | Gramps lat/long string not parseable | falls through to GeoNames | report |
| `ADDRESS_GRADE_PLACE_COLLAPSED` | projection | street, number, building, farm or neighborhood place | collapsed to the enclosing settlement | report |
| `PRIVATE_EXCLUDED` | projection | `private: true` | object and references dropped | report count |
| `DANGLING_REF` | projection | handle not found | edge or ref dropped | report |
| `GRAPH_CYCLE` | generations | ancestor cycle | `generation: null` for cycle members | report ids |
| `PLACEHOLDER_MEDIA` / `MEDIA_MISSING` / `UNSUPPORTED_FORMAT` / `RECT_INVALID` / `ORIENTATION_NOT_BAKED` | faces | §5.5 | `face: null`, or a normalized crop | report |
| `GRAPH_UNAUTHENTICATED` | island | 401 after the refresh retry | sign-in with `returnTo` | the existing sign-in flow |
| `GRAPH_NOT_PUBLISHED` | island | 403/404 | empty state | "the family tree is being prepared. you can find anyone through search." |
| `GRAPH_SCHEMA_UNSUPPORTED` / `GRAPH_PARSE` | island | bad version or body | error state + retry | "the family tree didn't load. try again." |
| `FOCUS_NOT_FOUND` | island | unknown `?focus` or sub | fallback (§9.4) | polite notice |
| `CHART_CHUNK_FAILED` | island | lazy import rejects | outline-only mode | "the chart didn't load. the outline below has everything." |
| `FACE_LOAD_FAILED` | island | non-200 face | initials avatar | nothing |

## 18. Decisions

| id | question | default | needs io |
|---|---|---|---|
| VIZ-D1 | Which visualization approach is adopted? | **Decided:** the verified recommendation in the viz ADR DOC-A4FBA13AE98A (§4.3). The MVP is Concept A, the Family Card Navigator. v2 adds C-lite lifelines, Faces and a desktop big-tree poster laid out by d3-dag 1.2.2 at build time. v3 adds Journeys. The ADR's budget changes are in §11. The hourglass in §4.3 was the fallback and is not used. | **answered:** io's sheet answer to Q9 (Q2-13), "all approved. proceed.", on 2026-10-13 (DOC-C31D9E3DD932; recorded verbatim in ADR 4.1) |
| VIZ-D2 | How is the graph served? | Static `person/graph.json` plus `media/faces/` under existing gated prefixes, with no API route | no |
| VIZ-D3 | What is the builder's input contract? | `_class`-tagged Gramps JSON lines (the cloud-store snapshot format), streamed from a read-only SQLite copy in the interim | no |
| VIZ-D4 | Which living-person fields go in the graph? | Name, birth year, birth city and primary-photo face crop, matching `person/index.json` and the hero. Never a day or month. Gramps private objects are excluded. | no (no new exposure) |
| VIZ-D5 | Does the v2 places layer include Residence events of living people? | No. They are dropped at build time; births, deaths, marriages and education stay. | **yes** (privacy-defining aggregate: "where everyone lives now") |
| VIZ-D6 | How is geocoding done? | Offline at build time (§5.6, as amended): GeoNames cities1000 plus admin1 and admin2 (CC BY 4.0), with a parent matched at admin1 or admin2, an alternate-name search and an override table. State, province and country places take Natural Earth or Census Gazetteer centroids. Gramps lat/long wins. Reviewed coordinates go back into Gramps, or into a reviewed `places.geo.json` outside the repo. The credit reads "Place coordinates: GeoNames (geonames.org), CC BY 4.0, modified". | no |
| VIZ-D7 | What is the family tab destination, and how does it sequence with R-20? | `/tree/` (`/private/` redirects there). Supersede HFY-R74 clause 1. Flip in the same release group as R-20. | no |
| VIZ-D8 | How are generations numbered? | Longest path per component with married-in partners aligned; 0 is the oldest; the UI uses relative labels only | no |
| VIZ-D9 | What is the face crop rule? | Gramps truncating crop on stored pixels, square-expanded, 160 px WebP, content-hashed name | no |
| VIZ-D10 | Is the viz a kit package or local to HFY? | Local to HFY. A tokens patch only if the ADR needs one. | no |
| VIZ-D11 | What is the basemap? | **Settled by the ADR:** v3 Journeys uses maplibre-gl 6.14.0 (exact pin, never v5), pmtiles 4.5.0 and @protomaps/basemaps 5.7.2. They run over a self-hosted maxzoom-11 PMTiles extract under `map/`, with versioned file names and a Cloudflare Cache Rule, behind gate G-map. There is no SVG places layer in v2. | no (settled by the ADR); G-map is io's go-ahead for the upload and the Cache Rule |
| VIZ-D12 | Era bands in the v2 time layer, and the chapter copy of v3 Journeys (Q2-14), on hard history such as slavery, Reconstruction and the Great Migration | Ship decades only. Add era bands, or Journeys chapter titles and copy, only from a copy list io approves. | **yes** (tone of hard history is io's call) |

## 19. Tasks

The waves: W0 is intake; W1 and W2 are the data prerequisites (start now); W3 and W4 are the MVP; W5 and W6 are v2. Every harrisonfamily task is `github_pr_deploy`, the io-kit task is `code_only`, and the intake is `no_code`.

| key | wave | repo | depends on |
|---|---|---|---|
| viz-research-intake | W0 | none | — |
| viz-graph-builder | W1 | harrisonfamily | — |
| viz-generation-index | W1 | harrisonfamily | viz-graph-builder |
| viz-face-crops | W1 | harrisonfamily | viz-graph-builder |
| viz-geocode-offline | W1 | harrisonfamily | viz-graph-builder |
| viz-graph-publish | W2 | harrisonfamily | viz-generation-index, viz-face-crops, viz-geocode-offline |
| iokit-tokens-viz | W3 | io-kit | viz-research-intake |
| viz-page-shell | W3 | harrisonfamily | viz-research-intake, viz-graph-builder |
| viz-outline-navigator | W3 | harrisonfamily | viz-page-shell |
| viz-mvp-visual | W4 | harrisonfamily | viz-outline-navigator, iokit-tokens-viz |
| viz-mvp-flip | W4 | harrisonfamily | viz-mvp-visual, viz-graph-publish |
| viz-v2-places | W5 | harrisonfamily | viz-mvp-flip |
| viz-v2-time | W5 | harrisonfamily | viz-mvp-flip |
| viz-v2-kinship | W5 | harrisonfamily | viz-mvp-flip |
| viz-v2-retire-graphviz | W6 | harrisonfamily | viz-mvp-flip |
| viz-graph-cloud-source | W6 | harrisonfamily | viz-graph-publish (and the sync domain's cloud store and renderer) |

## 20. Risks

- **The research recommends something that breaks the invariants.** Examples: an EPL or GPL layout engine, a 400 KB+ chart chunk, or a SaaS tile or geocoding API. The intake rejects it, or moves the layout to build time as an additive `layout` block. If the report is late, the UI waves slip; the data waves do not.
- **Cross-domain coupling with the cloud store (R-03).** The builder is source-agnostic (JSONL contract), but `viz-graph-cloud-source` waits on the sync domain's renderer. Until then graph.json is only as fresh as io's manual refresh.
- **`living` drift.** If the privacy domain changes the rule (combined `probably_alive`) in the person JSON renderer but not in the graph, the two would disagree. `--verify-against` (exit 5) blocks that.
- **Re-downloads.** `no-store` gated responses mean the graph and faces download on every visit. The budgets keep this under about 50 KB plus the visible faces; loosening HFY-R65 is not proposed.
- **Missing faces.** 14 of 29 record media are 0-byte Dropbox placeholders. Their faces stay missing until io marks the folders "available offline" and the build re-runs.
- **Duplicate tabs.** A nav-flip ordering mistake (R-20 before `familyViz`) gives two tabs that open the own page. VIZ-D7 couples the release groups.
- **Thin map.** 197 of 231 people have no placed event, and one city dominates. That is why the map is v2 and why the person and outline view stays the backbone.
- **Broken deep links.** Gramps ID renumbering or merges break `?focus=` deep links, the same as for person URLs. The sync domain's ID policy covers this.
- **Unmaintained gazetteer.** GeoNames files change daily. The lock file pins our copy, and an update is an explicit re-pin.
- **The whole tree in one fetch.** Any member can now fetch the whole tree's structure in one request. It was equally reachable before, just spread across person files, so the audience is unchanged. The edge gate still does not check revocation (an existing up-to-1 h exposure).
- **Hand-mirroring.** The new repo-owned `/tree/` page must be mirrored to the Dropbox Eleventy source (HFY-R46), or an Eleventy refresh would drop it. That is part of `viz-page-shell`'s ACs.
