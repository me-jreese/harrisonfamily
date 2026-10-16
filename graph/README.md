# graph

The family graph builder (HFY-PLN-002, task `viz-graph-builder`). It turns `_class`-tagged Gramps JSON lines into `person/graph.json` (schema v1), the one static file the family-tree page reads. The design is in the plan's visualization domain, sections 5.1 to 5.3 and 17.

This package is private. Its runtime dependencies are `d3-dag` (exact pin 1.2.2, the poster layout; see [Layout](#layout)) and `sharp` (Apache-2.0, exact pin, 0.35.x, Node 20.9 or later), used only to crop faces; they and their dependencies (sharp's libvips binaries are LGPL, javascript-lp-solver is Unlicense) stay in `graph/node_modules` and never reach the site output, and none appears in another lockfile in the repository. `ajv` is a dev dependency, and the tests use it to cross-check the built-in schema validator. Node 22 or later.

## Run it

```sh
# from a file of JSON lines, or stdin with "-"
node graph/bin/build-graph.mjs lines.jsonl --out <staging>
node graph/bin/build-graph.mjs - --out <staging> < lines.jsonl

# interim: straight from a COPY of the Gramps tree (sqlite3 -readonly, streamed over a pipe, nothing staged on disk)
node graph/bin/build-graph.mjs --from-gramps-copy <copy>/sqlite.db --out <staging>

# check a graph that is already written, for example the published copy
node graph/bin/build-graph.mjs --verify <staging>/person/graph.json
node graph/bin/build-graph.mjs --verify <staging>/person/graph.json --verify-against <staging>/person
```

- `--out <staging>` writes `<staging>/person/graph.json`. Without it the run is a dry run: it projects and verifies, and writes nothing.
- `--report <path>` writes the local report (warning codes with gramps ids, never values). The default is `<project>/workspace-local/graph-build-report.json`, outside the synced staging prefixes. `<project>` is the checkout's parent directory (the repository's convention: the checkout sits at `<project>/repo`); in a worktree or any other layout, set `HFY_PROJECT_DIR` to the project root or pass `--report`. When `--verify-against` ran, the report records `livingCheck: { compared, missing }`.
- `--verify-against <staging>/person` compares each graph `living` flag with `person/<id>.json` `isLiving` (rule L). A person without a file is counted (stderr, and `livingCheck.missing` in the report) but not compared. If NO person in the graph has a matching file (an empty, wrong or unrelated directory), it fails with `INPUT_MISSING` (exit 2) rather than comparing nothing.
- `--media <dir>` names the staged media to crop faces from, as `<handle>.<ext>` (`.json` excluded); the default is `<staging>/media`. Faces are written to `<staging>/media/faces/` only with `--out`. See [Face crops](#face-crops).
- `--gazetteer <dir>` reads the offline gazetteer cache. The default is `$HFY_GAZETTEER_DIR`, else `~/Library/Caches/hfy-gazetteer`. See [Geocoding](#geocoding).
- `--generated-at <iso>` pins `generatedAt`, for reproducible output. `--max-gzip-bytes <n>` lowers the size budget (default 150 KiB). `--quiet` silences the summary.
- `--from-gramps-copy` takes the `sqlite.db` file or its directory. It refuses with `GRAMPS_OPEN` if `<dbdir>/lock` exists, so close Gramps or copy the tree first. `HFY_SQLITE3` names another `sqlite3` executable.

## What it guarantees

- **Allowlist only.** `src/project.mjs` reads the fields in the design's section 5.2 table and nothing else: years only, no handles, notes, addresses, URLs or attributes. Private objects, and every reference to them, are excluded. Address-grade places collapse to the enclosing settlement: by place type, by a home-like custom type, and by a place name that reads as a street address (a leading house number, or a Street/Road/Ave-style word after another word), whatever the type says. `living` is rule L (`death_ref_index == -1`) and `deathYear` is `null` for the living.
- **`verify()` before every write.** `src/verify.mjs` validates `schema/family-graph.v1.schema.json` (`additionalProperties: false` everywhere), rejects day-precise dates, e-mail addresses, phone numbers and URLs in any string, and checks year range, coordinate precision and references. A failure is `PRIVACY_VIOLATION` (exit 4) and nothing is written. It names JSON pointers and rules, never the value. `verify()` also rejects a person who is their own partner, or a child of a union they are a partner in, and a place name that reads as a street address. When `shared/privacy-guard.mjs` exists and exports `scanText(text)`, that detector runs too; if the file exists but does not load or has no `scanText`, the build fails closed with `PRIVACY_VIOLATION` (a missing file just means the built-in detector runs alone).
- **Deterministic.** Arrays are ordered by gramps id and keys are sorted, so shuffled input gives a byte-identical file. The one clock input is `generatedAt`.
- **Atomic.** Every write is a temp file in the target directory, then a rename. A failure leaves the previous file untouched.

## Exit codes

| code | name | meaning |
|---|---|---|
| 0 | | done |
| 2 | `INPUT_MISSING` | no input, an unreadable file or database, an input with no people, bad arguments, an invalid clock value, a `--verify-against` directory that matches no person |
| 3 | `SIZE_BUDGET` | the gzipped graph is over the budget |
| 4 | `PRIVACY_VIOLATION` | `verify()` rejected the graph |
| 5 | `LIVING_MISMATCH` | `--verify-against` found a differing `living` flag |
| 6 | `GRAMPS_OPEN` | `<dbdir>/lock` exists |
| 7 | `SNAPSHOT_SHAPE` | an unknown `_class`, a missing core field, a line that is not JSON, a header schema other than 21, a `--from-gramps-copy` database whose `metadata.version` is not 21 (or cannot be read) |
| 8 | `GAZETTEER_CHECKSUM` | a cached gazetteer file differs from its pin in `gazetteer.lock.json`, or a download differs from it (`fetch-gazetteer` without `--update`) |

## Design notes

Where the build does something the design's section 5.2 table does not spell out. Each is for io or the privacy domain to ratify.

- **Living people keep six event types.** A living person's events are limited to birth, marriage, divorce, education, graduation and degree (the VIZ-D5 keep-list). Residence, custom ("Home") events, Medical Information, Cause of Death, cremation, occupation, military service, emigration and immigration are dropped, and death and burial are dropped with `LIVING_DEATH_EVENT_DROPPED` because they contradict rule L. Other drops are counted as `LIVING_EVENT_DROPPED` (residence stays silent, as before). `keepLivingResidence` still keeps residence on request.
- **`Family.event_ref_list` is read** to emit marriage and divorce events for each partner (VIZ-D5 says marriages stay). The 5.2 source column names only the person's `event_ref_list`; it needs a one-line amendment to add `Family.event_ref_list`.
- **`yearApprox` is narrower than the wording.** It is true only when a year was read AND the date's modifier is not NONE or its quality is not REGULAR. A text-only date, or one with no readable year, is not approximate, because there is no year to qualify.
- **Rule L has no carried-classification hook yet.** `isLiving()` in `src/project.mjs` is the single place `death_ref_index == -1` lives. If the privacy domain moves to a precomputed classification on the record, `isLiving()` is where the override goes, and `--verify-against` still catches drift.
- **Schema version.** `--from-gramps-copy` reads `metadata.version` (plain digits, JSON text or a small-int pickle) in the same sqlite3 query and rejects anything but 21. The sqlite3 child is killed if the consumer stops early.

## Geocoding

Coordinates come from place names only, matched offline at build time (`viz-geocode-offline`; the design's section 5.6 as amended by the viz ADR, VIZ-D6). No place name or person data leaves the machine.

```sh
# once, and again after reviewing a newer snapshot: the only command that uses the network
NODE_USE_ENV_PROXY=1 node graph/bin/fetch-gazetteer.mjs            # into $HFY_GAZETTEER_DIR or ~/Library/Caches/hfy-gazetteer
node graph/bin/fetch-gazetteer.mjs --update                         # re-pin files whose download changed
node graph/bin/build-graph.mjs lines.jsonl --gazetteer <dir> --out <staging>
```

- **Files.** `fetch-gazetteer` downloads the GeoNames dumps `cities1000.zip`, `admin1CodesASCII.txt`, `admin2Codes.txt` and `countryInfo.txt` (CC BY 4.0), and the Natural Earth `ne_10m_admin_0_countries.zip` and `ne_10m_admin_1_states_provinces.zip` (public domain). It pins each file's sha256, size and retrieval date in `graph/gazetteer.lock.json`. A download that differs from its pin fails with `GAZETTEER_CHECKSUM` and writes nothing, unless `--update` re-pins it. The cache must sit outside the repository. The dumps are never committed or shipped, and the GeoNames web service is never called. `NODE_USE_ENV_PROXY=1` is only needed behind a proxy.
- **Builds never fetch.** A build reads the cache and checks every file against its pin; a mismatch stops the build with `GAZETTEER_CHECKSUM` (exit 8). A missing cache, or a missing file, gives `GAZETTEER_MISSING`, and the build keeps Gramps coordinates only.
- **Precedence.** Gramps lat/long (`geo: "gramps"`), then io's reviewed coordinates, then the GeoNames match (both `geo: "geonames"`), then `null`. Country, state and province places take a Natural Earth centroid (`geo: "naturalearth"`), because `admin1CodesASCII` has no coordinates. A county or other admin2 area has no point: a map fits to its children. All coordinates are rounded to 2 decimals.
- **Matching.** The country comes first, by name, ISO code or alias. Each ancestor below it is then accepted as an admin1 or an admin2 of that country. Last, the place is matched against the class-P rows of `cities1000` by name, ASCII name or alternate name, accent- and case-folded, within the country and whichever admin codes are known. The most populous candidate wins. If the runner-up's population is within 2x, the result is `AMBIGUOUS_PLACE`; no candidate at all is `UNRESOLVED_PLACE`. Either way the place keeps `null`.
- **Local files next to the cache, never in Git.**
  - `overrides.json`, the override table, holds place names only: `{"version": 1, "countries": {"<name>": "<ISO2>"}, "places": [{"name": "<place>", "country": "<ISO2>", "admin": "<admin1 or admin2 code>" | "geonameId": <id> | "search": "<another spelling>"}]}`. It handles a region that GeoNames files as admin2 (`admin`), a city known by another name (`geonameId`), and a spelling folding cannot bridge (`search`).
  - `places.geo.json`, io's reviewed coordinates: `{"version": 1, "places": {"<place id>": {"lat": <n>, "lon": <n>}}}`.
- **The report.** The local report's `geocode` list holds, for each place, its source, its coordinates and, for a GeoNames match, the `geonameId`, population and runner-up. For an ambiguous place it holds both candidates. io reviews the list and writes the coordinates into Gramps lat/long through a handoff, so they sync as data, or approves a `places.geo.json`. The report is never synced.
- **Credit.** `attribution.geonames` is true whenever a GeoNames coordinate is used. Every surface that shows a coordinate prints `GEONAMES_CREDIT` from `src/geocode.mjs`, "Place coordinates: GeoNames (geonames.org), CC BY 4.0, modified", with its licence link.
- **Schema minor 1.** `places[].geo` gains the value `"naturalearth"`.

## Generations

`src/generations.mjs` (`viz-generation-index`, the design's section 5.4) fills `components`, each person's `generation` and `generations[]`. The function is pure and deterministic:

- Every child ref counts as a parent link, whatever its `rel`. A Kahn sort places what it can. Anything on or below an ancestor cycle gets `generation: null`, and its ids go to the local report as `GRAPH_CYCLE`.
- The generation is the longest path from the oldest ancestor. A partner with no parents takes the highest generation among its partners (the married-in alignment), within at most |people| rounds.
- Each component is shifted so that its oldest generation is 0. Its levels are ordered by `(birthYear ?? 9999, id)`.

Singletons are their own components at generation 0, with one level each, as the design's step 7 says. The design's invented example shows a singleton with `generation: null` and no `generations[]` entry; the prose is followed here.

## Layout

`src/layout.mjs` (`viz-graph-v2-layout`, the viz ADR's section 4.7) adds the optional `layout` block: x and y for the desktop poster, computed here at build time by d3-dag 1.2.2, so no layout code ships to the client. Schema minor 3.

- **The graph d3-dag sees.** Two kinds of node, people and unions, with links partner to union to child. A child of two unions has two parents; a person in two unions is laid out once.
- **Ranks.** A person sits at rank 2 x generation. A union with partners sits at 2 x (its highest partner generation) + 1. A partnerless union sits at 2 x (its lowest child generation) - 1. Without these, parentless siblings and their generation split across layers.
- **Operators.** `layeringSimplex` with those ranks, `decrossTwoLayer` and `coordGreedy`, node size 180 x 90. Never `coordSimplex` (217 s and 1,750 s at 2,000 synthetic people, against 12.9 s and 8.8 s) and never `decrossOpt` (NP-complete).
- **What is left out.** Only components with at least 2 laid-out people are laid out. Singletons and every `generation: null` person (a `GRAPH_CYCLE` member or a descendant of one) are filtered before d3-dag runs, because d3-dag 1.2.2 lays a cyclic graph out without an error.
- **Output.** Per component: `width`, `height`, `people[]` and `unions[]` as `{ id, x, y }`, and `bends[]` as `{ s, t, points }` for the links that span more than one layer only. Coordinates are integers, every array is sorted by id, and shuffled input gives a byte-identical file. The block is derived, so it is not part of the snapshot digest.
- **`engine` is `"d3-dag 1.2.2"`, with a space.** `verify()` scans every string outside `/source/` and rejects any `@` as an e-mail address, so `"d3-dag@1.2.2"` is `PRIVACY_VIOLATION` (exit 4). The same scan rejects a version that looks like a day-precise date (`1.10.12`), so a later pin change re-runs `test/layout.test.mjs` before it merges. `source.builder` keeps `hfy-graph@<version>` under its `/source/` exemption and strict pattern.
- **Budgets** (`test/layout-budget.test.mjs`, seeded synthetic families): graph.json gzipped with the layout block and photoEdges, at most 25 KB at 231 people and 150 KB at 2,000; layout time (the elapsed time of the layout call, which is what is asserted; the CPU time and the load average are printed beside it) at most 5 s at 231 people, run everywhere; at most 60 s at 2,000 people, only when `HFY_GRAPH_PERF=1` (the worker and io's machine, never a shared CI runner). The 2,000-person size case runs the full 2,000-person layout, so it is gated on `HFY_GRAPH_PERF=1` too. `photoEdges` is simulated in the size test (about 3 tagged photos per person, the density where the ADR says the budget is at risk) until `viz-graph-v2-data` emits the real block; re-run against it then. A miss fails the test. The remedy is an amendment to the ADR (for example a separate gated layout file), never a silent change to a number. The cloud builder (`viz-graph-cloud-source`, [above](#the-cloud-source-hfy-graph-render)) runs the same layout in Lambda; its 300-second timeout allows tens of seconds at 2,000 people.

## Face crops

`src/faces.mjs` (`viz-face-crops`, the design's section 5.5, VIZ-D9) crops each person's face from `Person.media_list[0]`, Gramps' person image, unless that MediaRef or its Media is private.

- **The crop rule (Gramps parity).**
  1. The rect `[x1, y1, x2, y2]` is integer percent; its corners are ordered and clamped to 0..100.
  2. It is converted to pixels by truncation on the stored pixels (`int(x * width / 100)`), with no EXIF auto-orient.
  3. The box is expanded to a square around its centre and clamped to the image. A missing or `[0,0,0,0]` rect uses the centre square of the whole image.
  4. The square is resized to 160x160 and encoded as WebP at quality 70; lower qualities are tried only if needed to stay within 8 KB. All metadata is stripped.
- **Naming.** `faces/<gramps_id>-<sha8>.webp`, where `sha8` is the first 8 hex digits of `sha256(source bytes || JSON(rect))`. An unchanged input writes nothing. Faces are written before `graph.json`, and faces it no longer references are removed after it is written.
- **No failure stops the build.** `MEDIA_MISSING`, `PLACEHOLDER_MEDIA` (a 0-byte file), `UNSUPPORTED_FORMAT` (any decode error, including HEIC with HEVC, which the prebuilt sharp cannot decode) and `ORIENTATION_NOT_BAKED` (an EXIF Orientation other than 1) give `face: null`. `RECT_INVALID` (a rect that is not four integers, or that truncates to zero pixels) also gives `face: null`; an invalid region is never guessed at, because a centre crop of a group photo could show someone else. The local report counts faces referenced, written and removed.

## Photo co-occurrence (`photoEdges`)

`projectRecords()` in `src/project.mjs` (`viz-graph-v2-data`, the viz ADR's section 4.7) emits `photoEdges`, an optional top-level block added in schema minor 2; the `layout` block followed as minor 3.

```json
"photoEdges": [ { "media": "O9001", "people": ["I9001", "I9003"] } ]
```

- **One entry per photo** with at least one tagged, kept person: `media` is the Media gramps id and `people` the sorted gramps ids tagged in it. Entries are sorted by `media`, so shuffled input gives a byte-identical file. The block is `[]` when nobody is tagged.
- **A tag is a `MediaRef` in a kept person's `media_list`**, any position (the face crop still uses only the first). A `MediaRef` with no rect, or Gramps' `[0,0,0,0]` "no region", is a whole-photo tag and counts.
- **Skipped:** a private Media (reported as `PRIVATE_EXCLUDED`), a private `MediaRef`, a private person, and a tag whose rect `faces.mjs` `normalizeRect()` calls invalid (not four integers, or a degenerate box), reported as `PHOTO_TAG_RECT_INVALID`. A `MediaRef` to a Media that is not in the input (`DANGLING_REF`) or whose gramps id does not fit the schema's id pattern (`MEDIA_ID_INVALID`) is skipped too, as is a tag to a gramps id that two Media share (`MEDIA_ID_DUPLICATE`), because edges are keyed by that id and the two photos would otherwise merge. The pure builder has no image size, so the one case `buildFaces()` sees only with pixels (a rect that truncates to zero pixels) is not caught here.
- **Nothing else leaves:** no handles, rects, paths, descriptions or notes. The schema's `photoEdge` object has `additionalProperties: false`, and `verify()` also checks that every person exists and that `media` and `people` are unique and sorted (`photo-edge-order`), and scans the block's strings with the same detectors as the rest of the file.
- **The snapshot id covers it.** `photoEdges` is part of the digest, so a change in who is pictured with whom gives a new `source.snapshot`.
- **Budget.** The block counts toward the existing gzip budgets (25 KB at 231 people, 150 KB at 2,000; the builder exits 3, `SIZE_BUDGET`, over 150 KB). `test/build.test.mjs` measures both with one tagged photo per person (1 to 4 people each). About 3 tagged photos per person at 2,000 people passes 150 KB; the remedy then is an amendment to the ADR (for example a separate gated file), never a silent budget change.
- **Publishing.** The block rides in the graph.json the interim publisher already copies; nothing in the refresh how-to changes, and it appears at io's next refresh. The cloud graph builder (`viz-graph-cloud-source`) reuses this code and additionally skips MOD#-hidden `MediaRef`s and Media.

## The cloud source (hfy-graph-render)

Once the cloud store is the source of truth (R-03), the interim publisher is denied the data prefixes, so `person/graph.json` and `media/faces/` would freeze. `graph/cloud/` is the Lambda `hfy-graph-render` that keeps them current (HFY-TSK-274). It reuses `buildFamilyGraph()`, `buildFaces()` and `verify()` unchanged, plus the store view and the MOD# overlay of `api/src/records/`.

- **Trigger.** `hfy-sync-render` invokes it asynchronously after each successful `live` pass (`{"source":"render","seq":N}`); shadow and `off` never do. Reserved concurrency is 1. It waits once (`GRAPH_DEBOUNCE_SECONDS`, 15), reads `SYNC#HEAD` again, and skips when `SYNC#GRAPH.built_seq` already covers it, the set of hidden MOD# items is unchanged and `SYNC#GRAPH.expunge_epoch` equals `SYNC#HEAD.expunge_epoch` (absent = 0; `api/scripts/expunge.mjs` raises the epoch without moving the seq, so the graph is rebuilt without the removed value), so a burst of passes costs one build. It also skips while a push session younger than ten minutes is open. `{"force": true}` rebuilds at once.
- **Source.** `source.kind` is `cloud`: every live head of the store view (already redacted by the sync server), then the overlay as a signed-out reader sees it. A hidden note, `MediaRef` or Media is gone from the graph, from `photoEdges` and from the faces; a person whose primary photo is hidden gets `face: null`, and the next photo never stands in for it.
- **No gazetteer.** Only the Gramps coordinates in the store are used (`GAZETTEER_MISSING` is the normal case, not a finding).
- **Faces.** The photos are read from the site bucket (`media/<handle><ext>`, the extension from the Media's content type, else its path). New crops wait in memory; a face whose name (it holds the content hash) is already in `media/faces/` is neither cropped nor uploaded.
- **Order.** Nothing is written before `verify()` and the size budget pass. Then: the new faces, `person/graph.json` (only when its `source.snapshot` changed), the removal of faces the graph no longer names, and the `SYNC#GRAPH` marker. A failure at any earlier point leaves the previous graph and faces in place, emits the `RenderError` metric that `<function>-RenderError` alarms on, and stores only an error code in `SYNC#GRAPH.last_error`. No message, name or id is logged.
- **Package.** `bash scripts/ci/package-graph-render.sh` builds `dist/hfy-graph-render.zip` with the linux/arm64 `sharp` binaries and prints the `GraphRenderCodeKey`. `bash scripts/ci/smoke-graph-render.sh` invokes the deployed function with `{"smoke":true}`, which crops a synthetic face and calls no AWS service. See [Deploy the graph renderer](../docs/how-to/deploy-the-graph-renderer.md).

## Test

```sh
cd graph && npm ci && node --test
```

`HFY_GRAPH_PERF=1 node --test` also runs the 2,000-person layout-time budget (60 s, elapsed time, so run it on a quiet machine) and the 2,000-person size budgets, which are skipped otherwise.

The suites use synthetic fixtures only (invented names, places and ids). `UPDATE_GOLDEN=1 node --test test/build.test.mjs` rewrites the messy-genealogy golden after an intended output change. Never put a real name, date, Gramps id or contact detail in a fixture.
