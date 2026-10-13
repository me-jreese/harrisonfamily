# graph

The family graph builder (HFY-PLN-002, task `viz-graph-builder`). It turns `_class`-tagged Gramps JSON lines into `person/graph.json` (schema v1), the one static file the family-tree page reads. The design is in the plan's visualization domain, sections 5.1 to 5.3 and 17.

This package is private. It has no runtime dependencies: `ajv` is a dev dependency, and the tests use it to cross-check the built-in schema validator. Node 22 or later.

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

## Not here yet

The generation index (`generation`, `generations`) and face crops (`face`, `counts.faces`) belong to later tasks (`viz-generation-index`, `viz-face-crops`). Their fields are in schema v1 and are written as `null`, `0` or an empty list until then. `components` is computed here.

## Test

```sh
cd graph && npm ci && node --test
```

The suites use synthetic fixtures only (invented names, places and ids). `UPDATE_GOLDEN=1 node --test test/build.test.mjs` rewrites the messy-genealogy golden after an intended output change. Never put a real name, date, Gramps id or contact detail in a fixture.
