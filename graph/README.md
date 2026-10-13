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
- `--report <path>` writes the local report (warning codes with gramps ids, never values). The default is `workspace-local/graph-build-report.json` next to the repository checkout, outside the synced staging prefixes.
- `--verify-against <staging>/person` compares each graph `living` flag with `person/<id>.json` `isLiving` (rule L). A person without a file is reported, not compared.
- `--generated-at <iso>` pins `generatedAt`, for reproducible output. `--max-gzip-bytes <n>` lowers the size budget (default 150 KiB). `--quiet` silences the summary.
- `--from-gramps-copy` takes the `sqlite.db` file or its directory. It refuses with `GRAMPS_OPEN` if `<dbdir>/lock` exists, so close Gramps or copy the tree first. `HFY_SQLITE3` names another `sqlite3` executable.

## What it guarantees

- **Allowlist only.** `src/project.mjs` reads the fields in the design's section 5.2 table and nothing else: years only, no handles, notes, addresses, URLs or attributes. Private objects, and every reference to them, are excluded. Address-grade places collapse to the enclosing settlement. `living` is rule L (`death_ref_index == -1`) and `deathYear` is `null` for the living.
- **`verify()` before every write.** `src/verify.mjs` validates `schema/family-graph.v1.schema.json` (`additionalProperties: false` everywhere), rejects day-precise dates, e-mail addresses, phone numbers and URLs in any string, and checks year range, coordinate precision and references. A failure is `PRIVACY_VIOLATION` (exit 4) and nothing is written. It names JSON pointers and rules, never the value. When `shared/privacy-guard.mjs` exists and exports `scanText(text)`, that detector runs too.
- **Deterministic.** Arrays are ordered by gramps id and keys are sorted, so shuffled input gives a byte-identical file. The one clock input is `generatedAt`.
- **Atomic.** Every write is a temp file in the target directory, then a rename. A failure leaves the previous file untouched.

## Exit codes

| code | name | meaning |
|---|---|---|
| 0 | | done |
| 2 | `INPUT_MISSING` | no input, an unreadable file or database, an input with no people, bad arguments |
| 3 | `SIZE_BUDGET` | the gzipped graph is over the budget |
| 4 | `PRIVACY_VIOLATION` | `verify()` rejected the graph |
| 5 | `LIVING_MISMATCH` | `--verify-against` found a differing `living` flag |
| 6 | `GRAMPS_OPEN` | `<dbdir>/lock` exists |
| 7 | `SNAPSHOT_SHAPE` | an unknown `_class`, a missing core field, a line that is not JSON, a header schema other than 21 |
| 8 | `GAZETTEER_CHECKSUM` | reserved for the geocoding task |

## Not here yet

The generation index (`generation`, `generations`), face crops (`face`, `counts.faces`) and geocoding (`geo: "geonames"`) belong to later tasks (`viz-generation-index`, `viz-face-crops`, `viz-geocode-offline`). Their fields are in schema v1 and are written as `null`, `0` or an empty list until then. `components` is computed here.

## Test

```sh
cd graph && npm ci && node --test
```

The suites use synthetic fixtures only (invented names, places and ids). `UPDATE_GOLDEN=1 node --test test/build.test.mjs` rewrites the messy-genealogy golden after an intended output change. Never put a real name, date, Gramps id or contact detail in a fixture.
