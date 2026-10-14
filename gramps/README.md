# gramps

Code and tests for the Gramps side of the sync design (HFY-PLN-002). This page covers the synthetic fixture tree and its test lane (HFY-TSK-228) and the site renderer (HFY-TSK-229); the schema export (HFY-TSK-231) is the last section; other tasks add the addon and more beside them.

Every value under `gramps/tests/fixtures/` is fictional. Phones are 555-01xx, mail is example.org, addresses are documentation-style, names are invented. Never copy a record, date, name or contact detail from the real tree into this directory (D-03).

## The fixture tree

`gramps/tests/fixtures/` holds files that are generated and committed together:

| File | What it is |
| --- | --- |
| `make_synthetic_tree.py` | The generator. Runs under the bundled Gramps 6.0.6 through the shim. |
| `synthetic-tree.gramps` | The tree as Gramps XML (plain, not gzipped). Import it with the Gramps CLI. |
| `synthetic-tree.jsonl` | The same tree, one Gramps 6 `json_data` object per line, keys sorted. |
| `synthetic-tree.census.json` | Case name to the Gramps IDs that show it. |
| `synthetic-tree.sha256` | sha256 of every file here and of `media/*`. |
| `media/` | The six tiny files the Media objects point at: a JPEG with EXIF GPS, a plain JPEG, the private person's own JPEG, a zero-byte placeholder, a birth-certificate PDF and a private scan PDF. No two have the same bytes. |
| `census.py` | Standard-library census of the cases, shared by the generator and the unit test. |

The tree covers every case in the sync design's testing section and the review scenarios: full birth dates, baptism (deceased, with a day), christening, blessing and stillbirth events, RANGE, SPAN and TEXTONLY dates, a Birth event the review retypes to Residence, a citation of a birth event with a full date, a birth-name `Name.date`, a birth-certificate PDF, private objects and private secondary elements (a private person with an exclusive birth event, note and photo, a private family, a private ChildRef), a Farm place, a custom `Home` place, a place with 6-decimal coordinates, a street place with `alt_loc` fields, addresses, email and contact-channel Urls, phones and emails in notes, styled note tags, AGE, SSN, TIME and merged-ID attributes, every father and mother child relation (`None` through a named custom one), every family type, two tags of one person in one photo, a `[0,0,100,100]` rect and a float rect, and a zero-byte media file.

It also covers the redaction rules of the design's section 5 that the testing list leaves out: a private Source, Repository and Place; a private RepoRef and a private SrcAttribute; shared references to excluded or held objects (a citation of the private citation, a RepoRef to the private repository, a place under the private place, a MediaRef to a private Media, a child of the private family, a ChildRef to the held person, and shared families whose father is held or whose mother is private); AGE, FATHER_AGE, MOTHER_AGE and TIME attributes on events and on event refs; a person's exact full birth date in a note and a non-birth event on that date; a NUMBER place; and a PO box in a note. `census.py` lists every case by name.

Three Gramps behaviours to know. The XML exporter floors float rects and drops a `[0,0,100,100]` rect, so the XML alone loses those two cases; the Gramps lane puts them back after the import (below), and the census runs on the imported tree too. Gramps points a person's `birth_ref` only at a Birth event (its XML import resets anything else), so the stillbirth and the christening are fallback events, not birth references. Gramps maps a type given by name through the translated names (under German, an event type named `Geburt` becomes a standard Birth), so the generator builds every custom type by value and pins the locale to US English before it imports Gramps.

### Regenerate or check

```bash
gramps/tests/gramps/gramps-shim.sh --script gramps/tests/fixtures/make_synthetic_tree.py          # rewrite the files and the D-03 allowlist lines
gramps/tests/gramps/gramps-shim.sh --script gramps/tests/fixtures/make_synthetic_tree.py --check  # byte comparison, writes nothing
```

Commit all of the changed files together. The output depends only on `SEED`, `FIXED_TS` and the Gramps version: handles, change times and the XML `created` date are fixed, `time.time` and `TZ=UTC` are pinned, and the locale is pinned (`LANG`, `LC_ALL` and `LANGUAGE` set to US English before Gramps is imported). The generator builds the tree in memory and in a throwaway directory first, runs the census on it, and writes nothing if a case is missing.

### Check without Gramps

```bash
python3 -m unittest discover gramps/tests/unit
```

This verifies the goldens against `synthetic-tree.sha256`, runs the census, cross-checks the XML against the JSONL (handles, IDs and privacy flags), scans every string for anything not obviously fictional, checks the GPS EXIF bytes, and checks the allowlist hashes and the `.gitignore` rules. A worker with no Gramps installed can write tests against the goldens and trust them. The fictional-value check runs every string through the project's R-18 scanner (`hfygramps/scanner.py`) and a plain digit-run rule: every phone must be 555-01xx (optionally `1-555-`) and every mail domain `example.org` or a subdomain of it, and negative controls prove that real-looking values planted in a note are caught. The two tests that regenerate the files (`--check`, in a throwaway `GRAMPSHOME` with the real Gramps and Pictures folders forbidden; once in the caller's locale, once in German with another time zone) skip unless `/Applications/Gramps.app` is Gramps 6.0.6 (set `HFY_GRAMPS_APP` for another path, `HFY_SKIP_REGEN=1` to skip them).

## The bundled-Gramps shim

`gramps/tests/gramps/gramps-shim.sh` runs a Python file or the Gramps CLI inside the interpreter embedded in `Gramps.app`. It builds a throwaway bundle that symlinks the real libraries, copies and re-signs the small launcher executable, and swaps in a launcher that runs your script. Nothing in `/Applications` changes. It refuses a bundle that is not Gramps 6.0.6, because the launcher rewrite is coupled to that layout (`HFY_GRAMPS_ALLOW_VERSION=1` overrides). With no `GRAMPSHOME` set it uses a throwaway `GRAMPSHOME` and `HOME` of its own, so a bare run never reads the real Gramps config, plugins or trees. It can also install an audit hook (`HFY_SHIM_FORBID`, with `HFY_SHIM_AUDIT_LOG`) that refuses and logs any open, directory listing, sqlite connect or process start that names a forbidden path. The hook is a tripwire for test code, not a sandbox: Python raises no audit event for `stat`, and a child process is checked only by its command line.

## The Gramps integration lane

```bash
gramps/tests/gramps/run.sh            # every test_*.py in that directory
gramps/tests/gramps/run.sh test_template_tree.py
```

`run.sh` makes a temporary `GRAMPSHOME` and `HOME`, imports the fixture once into a template tree with the Gramps CLI, finishes the template with `prepare_template.py`, copies that tree for each test file, and runs the test against its own copy (`HFY_TREE_NAME`). It then checks that the template did not change. `prepare_template.py` sets the template's media path to `gramps/tests/fixtures/`, so every Media path (`media/...`) resolves to its committed file; without it Gramps resolves relative media paths against GLib's Pictures folder, which on macOS is the account's real `~/Pictures` whatever `HOME` says. It also restores the two rects the XML format drops, from the JSONL, so the template equals `synthetic-tree.jsonl` object for object. It never reads `~/Library/Application Support/gramps/grampsdb`: every step, the stdlib helpers included, runs in the bundled Python under the audit hook with the real Gramps folders and the real `~/Pictures` forbidden, and the script fails if a violation is logged or the hook saw no file access at all. Negative controls prove the hook refuses the real `grampsdb` and `~/Pictures` paths (by the audit event alone, so nothing there is opened even if the hook were broken) and blocks a real `open()` and a sqlite connect of a file in a throwaway forbidden directory. `fixture_trees.py` is the stdlib helper tests use to find and copy trees; `fresh_copy(self, GRAMPSHOME)` gives one test method its own copy, removed when the test ends.

The lane needs a Mac with Gramps 6.0.6 (the `io-mac-gramps` runner). CI does not run it.

## The redaction policy

`gramps/redaction/redaction-v1.json` is the one declarative source of what never goes to the cloud (HFY-TSK-230): every rule with an id, class, path pattern and action, the single `isBirthLike` list, and the tables the rules read. `redaction-v1.schema.json` is its JSON Schema, `vectors/*.json` are the golden vectors that the projection, the server validator, the edit guard and the renderer must pass, and `make_vectors.py` and `render_reference.py` write the vectors and [`docs/reference/redaction-policy.md`](../docs/reference/redaction-policy.md). `hfygramps/rules.py` loads the policy and holds the pure predicates; `shared/redaction-rules.mjs` is the JavaScript port. Change a rule in the JSON, regenerate both, and commit them together; the unit tests fail when anything drifts.

```bash
python3 gramps/redaction/make_vectors.py            # rewrite the vectors (--check compares bytes)
python3 gramps/redaction/render_reference.py        # rewrite the reference page (--check compares bytes)
python3 -m unittest discover gramps/tests/unit      # schema, rules, vectors, oracle, fixture tree, drift
```

## The site renderer

`hfygramps/render/` renders the whole data site from one store view: `render_site(objects) -> {s3_key: bytes}`. It is the live ETL's D-02-fixed transforms (`scripts/etl/transform.py`, `export_person_data.py`) and `scripts/search/build_search_index.js`, ported to pure Python 3.12 functions with the standard library only. It opens no file, SQLite database or socket (a test patches `open` and `socket` to prove it), reads no clock and uses no randomness. Nothing calls it yet: the render Lambda (`render-lambda`) is its first caller.

| Piece | What it does |
| --- | --- |
| `site.py` | `render_site(objects, *, media_files=None, generated_at=..., text_gate=None)`; `render(...)` returns the same files plus a counts-only `RenderReport`. |
| `transform.py`, `labels.py`, `note_tags.py` | The ETL's transforms, label tables and note markup, name for name. Events keep the legacy ordering key `(date.sortval, label)`; `sortval` is never published. |
| `search_index.py` | `person/index.json` and `person/search-index.json`, in `build_search_index.js`'s shapes and `JSON.stringify` format, stamped with the caller's `generated_at`. |
| `places.py` | Street-level and home-like places (Street 7, Building 19, Number 20, Farm 18, and custom types matching `house\|home\|residence\|address\|apartment\|apt\|lot\|farm`) are never published; what points at one is re-pointed to its nearest kept ancestor. The custom-type pattern is the spec's, unanchored on purpose (it also matches inside `Charlotte` or `Allotment`: over-exclusion fails safe, and a narrower match than the projection's would publish a place the projection holds back). |
| `policy.py`, `text_scan.py` | Private objects and elements, and AGE, FATHER_AGE, MOTHER_AGE, TIME, SSN and ID attribute values, never publish. A second text gate (an io-visible change from the live ETL's allowlist) withholds any note, region note, MediaRef attribute value, citation title, event description or media description that the R-18 detector (`scanner.py`) or the live ETL's own scanner flags; a place URL whose path or description is flagged, or that is a contact link or an e-mail type, is dropped; a note LINK value that is flagged, or that carries userinfo, becomes plain text. |

Interim rule copy. The place-type lists (`places.py`) and the sensitive-attribute lists (`policy.py`) are a local copy of rules whose one source is `gramps/redaction/redaction-v1.json` (BRD2 D2-32: the projection, validator, edit guard and renderer import it; nobody keeps a local list). That file ships with `redaction-policy-v1`. Until then `test_render_rules.RuleSourceAgreement` fails if the file appears in the tree and disagrees, and `render-lambda` / `projection-py` own replacing the lists with an import (TODO in both modules). The renderer sits behind the projection, which removes these places and attributes first; nothing but that test keeps the two copies in step today.

Free text the renderer does not gate itself: person, family and place names, `Place.title` and `Place.code`. They come from the store view, where the projection's scan (sync.md 5.4) has already run, and the render Lambda's output re-check (BRD2 section 11.1) is the second line.

`objects` is the redaction projection's output, `{handle: Gramps 6 object}` or any iterable of such objects. `media_files` is `{media handle: {"checksum", "size", "ext"}}` for the blobs that exist (a media object with no entry renders `missing: true`); the store view blanks `Media.path`, so `ext` gives the stored extension.

### Parity with the live ETL

`gramps/tests/fixtures/render/` holds the parity run: `parity.py` builds P(fixture), the synthetic tree plus a few hand-written fictional objects (the note vectors, MediaRef attributes, notes and citations, a custom role). `project()` there is a stand-in for the redaction projection of sync.md 5.1 (private flag and holds only); `projection-py` replaces it, and then the golden is regenerated. `golden/legacy/` is what the live ETL and `build_search_index.js` write for it, and `expected-deltas.json` lists every difference from `render_site`, pointer by pointer, each under a rule in `deltas.py`. Besides the rule list the document records `manifest_order` (the legacy place and media manifests are pinned to the renderer's order, so they match by construction), `fixture_basis` (P(fixture) is the supplemented tree plus a stand-in projection, so the parity claim is only as strong as that stand-in) and `renderer_only` (the text gate). Today the only rule is the excluded places; private, held, orphan-of-private and text-gated objects are listed as cases that both sides leave out. `test_render_parity.py` requires everything else to be byte-identical.

The live ETL is not in this repository. A worker that has it regenerates the golden:

```bash
HFY_LEGACY_PROJECT=<project> python3.12 gramps/tests/fixtures/render/make_legacy_golden.py          # rewrite
HFY_LEGACY_PROJECT=<project> python3.12 gramps/tests/fixtures/render/make_legacy_golden.py --check  # byte comparison, writes nothing
```

`<project>` is the folder that holds `scripts/etl` and `scripts/search`. The script copies them to a throwaway directory, runs them on a SQLite copy of P(fixture) and pins the clock, the directory order and (for the two manifests) the set order, so the output does not depend on the machine. It needs `node` and refuses to write when a difference has no rule. `golden/legacy-source.json` records the sha256 of the live files the golden came from. The tests need none of this: CI runs them against the committed files.

## The Gramps schema export

`gramps/scripts/gen-schema.py` is the single source of Gramps schema truth (HFY-TSK-231). Store, validator and edit-schema code read its committed output and never call `get_schema()` themselves. It reads only the class definitions in the bundled Gramps 6.0.6 library; it opens no family database, no sqlite file and no tree.

| File in `gramps/schema/` | What it is |
| --- | --- |
| `gramps-6.0.6.schema.json` | JSON Schema 2020-12 for the 27 object classes (`$defs`), a `oneOf` over the ten primary objects, and `x-gramps` with the Gramps version (6.0.6) and DB schema (21). Every object is closed (`additionalProperties: false`) and requires `_class`. |
| `gramps-6.0.6.labels.json` | English value-to-label tables for EventType, PlaceType, ChildRefType, FamilyRelType, EventRoleType, UrlType, AttributeType, NameType, NoteType, RepositoryType, SourceMediaType, NameOriginType and SrcAttributeType, with each table's Custom value. |
| `gramps-6.0.6.sha256` | sha256 of the two files above. |

`get_schema()` omits keys that Gramps serializes (`Date.format`, `Family.complete`, `Media.thumb`) and states a styled-text tag value too narrowly (it is `true` for bold). The generator adds those as `SUPPLEMENTS` (recorded in `x-gramps.supplements`) and proves, from an empty instance of every class, that no serialized key is left undescribed.

```bash
gramps/tests/gramps/gramps-shim.sh --script gramps/scripts/gen-schema.py          # rewrite gramps/schema/
gramps/tests/gramps/gramps-shim.sh --script gramps/scripts/gen-schema.py --check  # byte comparison, writes nothing
python3 gramps/hfygramps/schema_check.py                                          # no Gramps: hashes + fixture validation
python3 -m unittest discover gramps/tests/unit                                    # includes the byte-identical regeneration test on io-mac-gramps
(cd api && npx vitest run test/gramps-schema.test.js)                             # JS side: fixture validates, mutations fail
```

The fixture's float-rect object (listed under `rect_float` in `synthetic-tree.census.json`; `[12.5, ...]`) is a deliberate hostile input for the sync design, and `get_schema()` types a rect as integers, so the schema refuses it. The checkers (`schema_check.py` and the vitest) derive the expected-invalid set from that census key, require each such object to fail with rect errors only, and require every other object to validate. The ruling that "every fixture object validates" is relaxed for this hostile input is an open question for io; the schema stays strict. The float rule relies on the fixture's literal `12.5` style values: JavaScript cannot tell `10.0` from `10` after `JSON.parse`, while Python keeps `10.0` as a float and rejects it.

What the checks prove, and what they do not. Validation is closed-world on keys, not on completeness: every object requires only `_class`, so a missing key is not caught (drift in the serialized key set is caught by the generator's empty-instance proof, on the Gramps host). The validators are small subsets that raise on any keyword they do not implement; swap them for a standard validator when validator-js lands. CI (`ci.manifest.yaml`) runs the unit tests, which check the sha256 manifest, the recorded version and the fixture; that gate does not prove the goldens match what Gramps generates, because hand-edited goldens with a recomputed manifest would pass it. Reproducibility is proven only by `gen-schema.py --check` on a Mac with the Gramps 6.0.6 bundle (`io-mac-gramps`), run by hand or on that host. Commit the three schema files together.

## The projection

`gramps/hfygramps/projection.py` is the desktop side of the policy, `P` of sync.md section 5 (HFY-TSK-241). It is standard library only and imports nothing from Gramps, so it runs in Gramps' bundled Python and in CI.

```python
from hfygramps.projection import project_tree, project, update_birthlike_sticky

projected, holds = project_tree(objects, base=base, files=files, released=released, sticky=sticky)
result = project(objects, base=base, files=files, released=released, sticky=sticky)   # + excluded, withdrawn, fired, sticky
```

`objects` are Gramps `json_data` dicts. `projected` maps every handle to what the cloud receives, or `None` when it must not have the object. `holds` lists `{handle, rule, scope, pointer}` for what was held back (`scope` `"object"` or `"field"`); `hold_reason(rule_id)` is the sentence the preview shows. The context is the sidecar's: `base` (the last synced objects, which a hold falls back to), `files` (what the addon learned from the bytes on disk: `exif_gps`, `md5`, `readable`), `released` (media handles io released) and `sticky` (the `birthlike_sticky` event handles). `result.sticky` is the set to store after the run, and removing a handle from it is io's release in the GUI.

What it does beyond the rule list of the reference page, always in the safe direction:

- A projected object never has Gramps' `change` stamp (derived; the cloud object has none), so `P(lift(C, L)) == C` can hold.
- `birth_ref_index` and `death_ref_index` follow the same event reference through the filtered `event_ref_list`, and become -1 when it is gone.
- `dob_exact` checks every `Date` of every class against every local full birth date (also a date without a `_class`), and the text of a date as it checks free text. Free text is folded first (look-alike digits, invisible characters, spacing, case) and holds a full birth date in any listed form, zero-padded, comma-less, day-first or dotted, and the day and month alone within 60 characters of a birth keyword or of that person's given name, call name or nickname.
- An event in `birthlike_sticky` keeps day and month local, and counts as birth-like for the dates of its citations and for birth-linked media. An event that is birth-like now, was birth-like in the synced base, or shares a local birth date joins the set (`birthlike_sticky_additions`); a Birth retyped to Residence therefore stays sticky.
- A held `MediaRef` rectangle falls back to the rectangle of the same reference (`ref#n`) in the base, so reordering a list cannot move it.
- `project_coordinate`, `lift_coordinate`, `project_rect` and `lift_rect` are the two lift rules this module owns (precision comes back while the rounded value is unchanged; the full frame and a held rectangle come back); the rest of lift belongs to the merge engine.

`gramps/hfygramps/canonical.py` writes the canonical JSON and the sha256 of a stored object (`object_json`, `object_hash`; no `change` key; integers only; keys sorted by code point). `shared/canonical.mjs` is the JavaScript original of the same function, and both pass `shared/canonical.vectors.json`, which `gramps/redaction/make_canonical_vectors.py` writes (`--check` compares bytes). `gramps/tests/unit/test_canonical.py` also runs the JavaScript module with `node` when it is installed, over the vectors and over every projected object of the synthetic tree.

```bash
python3 -m unittest discover gramps/tests/unit     # includes test_projection.py and test_canonical.py
node --test shared/                                 # includes canonical.test.mjs
```
