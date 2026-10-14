# gramps

Code and tests for the Gramps side of the sync design (HFY-PLN-002). This page covers the synthetic fixture tree and its test lane (HFY-TSK-228) and the site renderer (HFY-TSK-229); the schema export (HFY-TSK-231), the projection, the merge engine (HFY-TSK-242) the desktop addon skeleton (HFY-TSK-179) and its transport and sign-in (HFY-TSK-180) are the last sections; other tasks add the rest of the addon beside them.

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

`hfygramps/render/` renders the whole data site from one store view: `render_site(objects) -> {s3_key: bytes}`. It is the live ETL's D-02-fixed transforms (`scripts/etl/transform.py`, `export_person_data.py`) and `scripts/search/build_search_index.js`, ported to pure Python 3.12 functions with the standard library only. It opens no file, SQLite database or socket (a test patches `open` and `socket` to prove it), reads no clock and uses no randomness. Its caller is the render Lambda, `lambda/hfy-sync-render/` (HFY-TSK-176; [The render Lambda](../docs/reference/sync-render.md)), which packages `hfygramps/__init__.py`, `scanner.py` and this folder with `scripts/ci/package-render.sh`.

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
- `dob_exact` checks every `Date` of every class against every local full birth date (also a date without a `_class`), and the text of a date as it checks free text. Free text is folded first (look-alike digits, invisible characters, accents, spacing, case) and then read structurally, not against a list of strings: every run of three numbers, month names or day words joined only by date separators is a full date when some assignment of it to year, month and day equals a local full birth date. That covers any order (Y-M-D, D-M-Y, M-D-Y), any separator (`- . / , space`, `of`, `de`), month names and abbreviations in English, French, Spanish, German, Italian, Portuguese and Dutch, ordinals and day words (`fifth`, `twenty-first`), two-digit years (any century) and compact `YYYYMMDD`, `DDMMYYYY` and `MMDDYYYY`. The day and month alone hold within 60 characters of a birth keyword or of that person's given name, call name or nickname, as a month name next to a day, or as two numbers joined by `/` or `-`, or `d.m.` with its closing dot; a bare `3 5` or `5.3` is not read as a date (too often a count or a decimal). One pass over a text finds all of this, so the cost does not grow with the number of birth days in the tree.
- An event in `birthlike_sticky` keeps day and month local, and counts as birth-like for the dates of its citations and for birth-linked media. An event that is birth-like now, was birth-like in the synced base, or shares a local birth date joins the set (`birthlike_sticky_additions`); a Birth retyped to Residence therefore stays sticky. Adding the events that are birth-like now and the ones that share a local birth date, not only those birth-like at the base, is deliberate: it widens what is protected, never what is shown. A run sees one base, so the set accumulates across syncs only if the addon (or the merge engine) stores what `update_birthlike_sticky(stored, objects, base, released)` returns and passes it back as `sticky` on the next sync. Release is explicit: a handle listed in `released` is removed from the stored set and no rule adds it back for as long as it is listed; it ends the persistence only, so an event that is a Birth today, or whose date is a local full birth date today, is still reduced by the ordinary rules while that holds.
- The cloud's own copy of a held object (`base[handle]`, kept while the object is held) goes through the references phase like any other object, so it never names an object that has since become excluded or held, and its birth and death indexes follow.
- A field hold puts back the last synced value of the same list element, found by what the element is (its other fields), not by its index, so an element inserted or removed earlier in a list cannot make a held value overwrite another element's; an element with no counterpart in the base holds the object whole. The pointer of a field hold is the pointer in the projected object, after the references phase removed list elements; a hold on an element that phase removes is dropped.
- A held `MediaRef` rectangle falls back to the rectangle of the same reference (`ref#n`) in the base, so reordering a list cannot move it.
- `project_coordinate`, `lift_coordinate`, `project_rect` and `lift_rect` are the two lift rules this module owns (precision comes back while the rounded value is unchanged; the full frame and a held rectangle come back); the rest of lift belongs to the merge engine. The golden vectors in `gramps/redaction/vectors/` exercise `P` (the full frame to null, a degenerate or float rectangle held, rounded coordinates); the lift side of coordinates and rectangles is covered by unit tests in `test_projection.py`, not by vectors.

`gramps/hfygramps/canonical.py` writes the canonical JSON and the sha256 of a stored object (`object_json`, `object_hash`; no `change` key; integers only; keys sorted by code point). `shared/canonical.mjs` is the JavaScript original of the same function, and both pass `shared/canonical.vectors.json`, which `gramps/redaction/make_canonical_vectors.py` writes (`--check` compares bytes). `gramps/tests/unit/test_canonical.py` also runs the JavaScript module with `node` when it is installed, over the vectors and over every projected object of the synthetic tree.

```bash
python3 -m unittest discover gramps/tests/unit     # includes test_projection.py and test_canonical.py
node --test shared/                                 # includes canonical.test.mjs
```

## The merge engine

`gramps/hfygramps/merge.py` is the desktop's three-way merge, lift and conflict model, sync.md section 6 as amended by BRD2 section 11.1 (HFY-TSK-242). It is standard library only and imports nothing from Gramps. The addon (`addon-pull-apply`, `addon-push`) is its caller; nothing deployed calls it yet.

```python
from hfygramps import merge as M

ctx = M.merge_context(local_objects, base_objects.values(), sticky)       # birth-like locally or at the base
r = M.merge_object(base, local, local_proj, cloud, cloud_version=C.version, project_fn=project_one,
                   pins=open_conflicts, mode="cli", ctx=ctx)               # one object
tree = M.merge_tree(base, local, local_proj, cloud, versions=..., pins=..., project_fn=..., mode="gui", sticky=sticky)   # all of them
obj = M.lift(cloud_obj, local_obj, local_proj)                             # the local-form object for a projected one
```

`base` is B (the sidecar's cloud copy), `local` is L (the raw Gramps `json_data`), `local_proj` is P(L) from `projection.project_tree`, and `cloud` is C (the pulled object, `M.TOMBSTONE`, or `None`). `project_fn(obj)` projects an object in the context of the whole local tree; the push object is `project_fn(lift(M, L))`.

What a result carries (`MergeResult`):

| Field | Meaning |
| --- | --- |
| `action` | `noop`, `unchanged`, `converged`, `create_local`, `push_create`, `update`, `delete_local`, `delete_deferred`, `push_delete`, `withdraw`, `drop_base`, `conflict` or `excluded` (the rows of sync.md 6.4 and the cases around them). |
| `local_obj` | `lift(M, L)`: what to commit in Gramps, or `None` when nothing changes locally. |
| `push` | `{"op", "class", "handle", "base_version", "obj"}` with `base_version = C.version`, or `None` when the push object equals C. A web edit to field a and a desktop edit to field b are both in `push["obj"]` and in `local_obj` after one run. |
| `base_after` | The object the sidecar's base row becomes once the push is acknowledged (C when nothing is pushed; unchanged while an object-level conflict is open). |
| `conflicts` | Every open conflict of the object: `id` (stable per class, handle and path), `kind` (`field`, `composite`, `list`, `delete_edit`, `identity` or `integrity`), `path` (RFC 6901, with list element keys such as `/media_list/<ref>#0/rect`), `reason`, projected `base`, `cloud` and `local` values (also as `*_json`), and `disposition` (`parked` for the CLI, `open` for the GUI). |
| `autos` | Automatic resolutions worth logging (both sides reordered a list). |
| `closed` | The pins the run found resolved. |

The rules are those of sync.md 6.2 to 6.7. Keyed lists (`event_ref_list`, `media_list`, `person_ref_list`, `reporef_list`, `placeref_list`, `child_ref_list`) merge element by element under the key `<ref>#<n>` and are matched to the base by content first, so a stale key is a `list` conflict and never a different element; ordered sets (`family_list`, `parent_family_list`, `note_list`, `citation_list`, `tag_list`) and bags (`alternate_names`, `attribute_list`, `urls`, `surname_list`, `alt_names`, `alt_loc`, `address_list`, `lds_ord_list`) merge by content, and a bag element replaced differently on both sides is an ambiguous-pairing conflict. A cloud change is a `composite` conflict when the local value is refined by a local-only part (a birth date with a local day and month, a street-level event place, a held field), and when it changes the `type` of an event, the `role` of a reference to it, or a person's birth reference while that event is birth-like locally or was at the base. An incoming tombstone for an object that holds a desktop-only part is a `delete_edit` conflict with the reason `has desktop-only data`; `lost` lists the pointers the preview shows.

Pinning. The caller stores each open conflict as a pin, `{"path", "base_json"}` (`base_json` is `None` for a path the base lacked), and passes the pins of an object on every run. While a pin is open its `base_json` is the base for that path and its descendants, so the sidecar's base row can advance for other paths without the run silently settling the conflict; the push carries the cloud value there and the local apply keeps the local value there. The run lists the conflict again each run and reports the pin in `closed` when the path has converged or has become one-sided. A pin with the path `""` is on the whole object (a delete against an edit, an identity conflict, an integrity freeze). It needs no kind or reason: the object is merged again every run, the same object-level conflict (same `id`) is listed while its cause stands, and the pin is reported in `closed` when the cause is gone. For an integrity freeze `merge_tree` re-checks the result, so a violation that still stands freezes the object again, and one that is gone ends the pin. Only violations that are new in the run freeze an object: a dangling or asymmetric reference already in the local tree before the run never blocks an unrelated cloud edit.

Conflicts hold projected values only, because the sidecar mirrors them to the cloud. To keep mine, read the raw desktop value with `M.local_value(conflict, local, local_proj, base)` and pass it as `M.resolve_conflict(conflict, "keep_mine", local_raw=...)`; without it `keep_mine` is refused, so the projection can never overwrite a street-level place or a held field. `delete_edit` conflicts for a tombstone list `lost_edited` (shared edits) and `lost_desktop_only` (desktop-only data) beside the combined `lost`, and the reason is `has desktop-only data` whenever the second list is not empty. `resolve_date` keeps the website's text, and the default choice falls back to `keep_mine` (flagged by `fallback`) when the two dates do not have the same shape (a range against a single date, a text-only local date).

An object that became excluded (private, private by association) after it was synced is withdrawn: `action: withdraw` with a `withdraw` push op, no step-up, base row dropped (`drop_base` when the cloud copy is already gone).

Two behaviours are deliberately conservative. A bag element that both sides dropped, with a different addition on each side, is an ambiguous-pairing conflict even if the additions look unrelated, because an edited element is a removal plus an addition. A keyed list whose raw desktop elements cannot be paired with the projection's (the projection's own element differs from the raw one and the counts disagree) holds the object as a stale key, never a guess; a private duplicate whose public twin matches by content is fine.

The sticky set. The merge engine is stateless. After every run the addon stores `M.update_baseline(stored_sticky, local_objects, base, released)` (the `birthlike_sticky` set: the stored one, the events birth-like now or at the base or sharing a local full birth date, minus what io released) and passes it back as `sticky` to `projection.project_tree` and to `merge_context` on the next run. The projection never carries Gramps' `change` stamp, so no other part of the baseline needs persisting beyond the base rows.

Composite date conflicts offer three choices (`M.date_choices()`): keep mine, take the website year and keep my day and month (the default), or take the website value and clear my day and month (it needs `confirmed=True`). `M.resolve_date(cloud_date, local_date, choice)` returns the date to store in Gramps and the date the cloud holds afterwards; `M.resolve_conflict(conflict, choice)` does the same for the other conflicts.

Relationship symmetry (6.6). `M.merge_tree` checks the post-merge local tree with `M.check_integrity`: references to a missing object or an object of the wrong class, a person's `family_list` against the family's parents, a family's children against the person's `parent_family_list`, and the birth and death indexes. A violation freezes the objects this run changes and that it involves (an `integrity` conflict, nothing applied or pushed for them, base row unchanged) and every other object proceeds.

```bash
python3 -m unittest discover gramps/tests/unit -p test_merge.py          # the merge engine alone (about 10 s)
python3 -m coverage run --branch --include='*/hfygramps/merge.py' -m unittest discover gramps/tests/unit -p test_merge.py
python3 -m coverage report -m                                            # 100 % statements and branches, none missing
```

`test_merge.py` has a test for every row of sync.md 6.3 and 6.4, the composite and tombstone rules, pinning over several runs, convergence of a web edit and a desktop edit in one run, and two seeded property tests over the synthetic tree: `P(lift(C, L)) == C` for 1,000 accepted random edit pairs (the checker is the projection: C must be a fixed point of P with no hold), and, for 500 random pairs of website and desktop edits, that a run without conflicts leaves Gramps and the cloud agreeing. `coverage` is not needed by CI; it is a development tool.

## The desktop addon skeleton

HFY-TSK-179 is the frame of the `hfy_sync` Gramps addon (sync.md section 8): registration, the `hfy-sync` command-line wrapper, the per-tree sidecar, `status.json`, and the refusals that stop a run before it touches anything. It has three real actions, `status`, `bind` and `login` (the transport and sign-in section below). `check`, `pull`, `push` and `sync` are registered and answer exit `69` (not enabled) until the pull-apply and push tasks fill them in. The how-to is [Install and run the Gramps sync addon](../docs/how-to/install-the-gramps-sync-addon.md).

| Path | What it is |
| --- | --- |
| `hfy_sync/hfy_sync.gpr.py` | Registers the tool (`TOOL_DBPROC`, so Tools > Family Tree Processing > Website sync..., GUI and CLI modes, `gramps_target_version` 6.0). Its `version` must equal `ADDON_VERSION` in `hfygramps/addon/consts.py`; a unit test checks it. |
| `hfy_sync/hfy_sync_tool.py` | The Gramps shell: a plain `Tool` (so Gramps keeps undo), its options (`action`, `dry_run`, `allow_deletes`, `yes`, `run_id`) and `GrampsTree`, which gives the runner the dbid, the schema, the tree marker and the handles. It imports everything at the top, because Gramps puts the addon folder on `sys.path` only while it loads the module. |
| `hfy_sync/hfy_sync_ui.py` | The two Gtk dialogs of the skeleton: status, and "Bind this tree?". The preview, conflict and apply dialogs of sync.md 13.1 come with the GUI preview task. |
| `hfygramps/addon/` | The runtime, standard library only and Python 3.9 compatible, with no Gramps import: `consts` (versions, exit codes, the refusal table), `paths` (the sync.md 4.3 layout), `status` (`status.json`, run ids), `sidecar` (`state.sqlite` with the sync.md 4.3 DDL), `binding`, `preflight` and `runner`. |
| `bin/hfy-sync` | The wrapper. It generates a run id, runs `Gramps -O <tree> -a tool -p name=hfy_sync,...,run_id=<id>`, reads `status.json` and exits with its `exit_code`; a missing file, or one with another run's `run_id`, is exit `70` (D41). Before Gramps starts it refuses `--force-unlock` (64), a tree whose database schema the addon does not read (78; Gramps would upgrade an older tree on open) and a tree with a `lock` file (75). It never removes a lock. |
| `scripts/build-addon.sh` | Writes `gramps/dist/hfy_sync-<version>/` (the Gramps files, a vendored copy of `hfygramps/` without `render/` and `schema_check.py`, and `redaction/redaction-v1.json`, which `rules.py` finds beside the package) and the zip of it. `dist/` is not tracked. |
| `scripts/install-addon.sh` | Builds, then replaces `<plugins>/hfy_sync`: `--dest`, else `$GRAMPSHOME/gramps/gramps60/plugins`, else `~/Library/Application Support/gramps/gramps60/plugins`. Nothing but the `hfy_sync` folder is touched. |
| `tests/unit/test_addon_runtime.py`, `test_addon_wrapper.py`, `test_addon_transport.py` | CI: the runtime against a fake tree, the wrapper against a fake Gramps command, the build and the installer in a temporary folder. |
| `tests/gramps/test_addon_skeleton.py`, `addon_support.py` | The Gramps lane (`io-mac-gramps`): installs the addon into the throwaway `GRAMPSHOME` and drives the real Gramps CLI and the wrapper on copies of the fixture tree. |

The sync state lives outside Dropbox and git, under `~/Library/Application Support/hfy_sync/` (`config.json`, then `<dbid>/` with `state.sqlite`, `state.lock`, `status.json`, `previews/`, `backups/`, `logs/`, `cache/`), all owner-only. The `<dbid>` is the tree's folder name under Gramps' `grampsdb` (`db.get_dbid()`). The tests point `HOME` and `GRAMPSHOME` at a temporary directory, so they never read or write the real one; the wrapper and the tool read `HOME` and `GRAMPSHOME` only.

```bash
python3 -m unittest discover gramps/tests/unit                  # CI: includes the two addon files
gramps/tests/gramps/run.sh test_addon_skeleton.py               # Mac with Gramps 6.0.6: the integration suite
gramps/scripts/install-addon.sh --dest <a-throwaway-folder>      # try the installer without touching Gramps
```

### Transport and sign-in

HFY-TSK-180 adds the network layer the later actions call, and the one action that uses it now, `hfy-sync login`. All of it is standard library and Python 3.9 compatible, and runs inside Gramps' bundled Python.

| Path | What it is |
| --- | --- |
| `hfygramps/addon/transport.py` | `make_ssl_context()` (urllib's default context; when its trust store is empty, as in Gramps' bundled Python, `/etc/ssl/cert.pem` is added; hostname and certificate checks are never off, and a context that does not verify is refused). `Http` (retries, no redirects), `Client` (the `/api/sync/*` calls, with the handshake headers), `Versions` and `TransportError`. |
| `hfygramps/addon/oauth.py` | `login()` (PKCE S256 and `state`, a one-shot `http.server` on `127.0.0.1` on an ephemeral port, five-minute wait, code exchange at `/auth/token`) and `TokenManager` (the access token in memory, refreshed with the stored refresh token). |
| `hfygramps/addon/keychain.py` | The refresh token in the login Keychain through `security`. |
| `scripts/probe-cloudflare.py` | The review DL-31 probe: one request from the bundled Python through Cloudflare, printing the status, the error code, the `cf-mitigated` header's presence and whether the fallback roots were needed. Counts and codes only. |
| `tests/unit/test_addon_transport.py` | CI: local https and http servers, a fake `security`, a fake sign-in server. |

**TLS.** `ssl.create_default_context()` first. Gramps' bundled Python 3.13 has an empty default store (checked on 6.0.6), so `/etc/ssl/cert.pem` is loaded into it; the check stays `CERT_REQUIRED` with hostname checking. A test serves https with a throwaway self-signed certificate and proves a refused handshake, the fallback and a hostname mismatch. A test also fails if the addon source ever contains `CERT_NONE` or an unverified context.

**Retries.** A call is idempotent when it is a `GET` or carries an `Idempotency-Key` (a replay of a batch). Those retry three times, after 1, 4 and 16 s, only on a network error or `503` with the error code `retryable`. Everything else is sent once. A certificate failure is not transient and is not retried. The token endpoint is never retried: a refresh whose answer was lost would leave the rotated token unknown and the next try would revoke the token family.

**Errors and exit codes.** `401` and `403 step_up_required` are exit `77` (`next_action` `login` and `step_up`); `426` and `409 redaction_version_mismatch` are `78` (`update_addon`). The rest follow sync.md 8.7: other `403` `78`, `sync_paused` and `404 not_enabled` `69`, `400`, `413` and `422` `65`, a retryable error that stayed after the retries, a network error and other `409` or `5xx` `75`. A message carries the status and the error code, never a response body.

**Handshake headers.** Every sync call carries `X-HFY-Sync-Client: hfy_sync/<semver>`, `X-HFY-Gramps-Version`, `X-HFY-Gramps-Schema`, `X-HFY-Redaction-Version` and, once the tree is bound, `X-HFY-Tree-Id` (sync.md 7.1), plus `Authorization: Bearer`. Every request also sends `User-Agent: hfy_sync/<semver>`. This one is not optional: Cloudflare answers urllib's default `Python-urllib/x.y` agent with its own `403` (`error code: 1010`) before the origin sees the request, and passes the named agent through (probe, below).

**Sign-in.** `hfy-sync login` (`--step-up` adds `prompt=login&max_age=300`) opens the browser at `/auth/authorize` for the `hfy-sync-desktop` client, resource `<server>/api/sync` (`https://harrisonfamily.us/api/sync` for the production server; derived from the configured server so the token audience always names the host that receives it), scope `sync`. The server URL must be a bare origin (a path is refused). The loopback server takes one callback: it checks the `Host` header, the `state` (constant time) and the issuer (`iss` is required, because the auth server always sends it, RFC 9207), then closes. Each accepted connection has a 5 s socket timeout, so a silent client (a browser preconnect) cannot stall the five-minute wait. The refresh token is written by `security -i` with the command on **stdin**, so it never shows in `ps`; the item is generic-password service `us.harrisonfamily.hfy_sync`, account `<issuer>|owner`, and is created with `-T <the Gramps bundle's Python>` so no other program reads it silently; and the write is read back. **Deviation from sync.md 6:** the account is `<issuer>|owner`, not `<issuer>|<sub>`, because the refresh path has to find the item before it holds any token (so any `sub`); one item per issuer, and a new sign-in replaces it. io to confirm or ask for a `sub` index. `security add-generic-password -U` keeps an existing item's access list, so a sign-in deletes any existing item first and creates it fresh (so `-T` always applies, including after a Gramps upgrade moves the bundled Python); rotation keeps `-U` so a failed write cannot lose the only copy of the new token. The real `security -i` quoting, `-T` and read-back behaviour is verified only against a fake in unit tests; the real-Keychain smoke test belongs to the io-mac closure step. Reading is `security find-generic-password -w`. A rotated refresh token is written and read back **before** the access token that came with it is used; if that fails the new access token is dropped. `invalid_grant` (a reused or revoked token, or 30 days idle) asks for a new sign-in (exit `77`) and removes the dead item, but only if the Keychain still holds the token that was sent: when another process (the wrapper and a Gramps run) rotated it first, the newer token is kept and the refresh retried once with it (no lock file; the retry covers the race). A `401` from an API call refreshes once and replays the request when it is safe to repeat (a `GET`, or a call with an `Idempotency-Key`). A locked Keychain is D42: exit `77` from the command line. `hfy-sync login` needs the tree closed in Gramps like every command-line action.

**The Cloudflare probe (DL-31).** `gramps/tests/gramps/gramps-shim.sh --script gramps/scripts/probe-cloudflare.py` sends one `GET /api/sync/meta` from the bundled Python with no token. On 2026-10-14, from Python 3.13.2 in Gramps 6.0.6: default store roots `0`, fallback used, `CERT_REQUIRED`; with the addon's agent the answer was the origin's house-format error (`404`, `not_found`, no sync route deployed yet) with no `cf-mitigated` header; with urllib's default agent it was Cloudflare's own `403`, `error code: 1010`. Run it again after the sync routes are live (the answer should then be `401`) and before the seed; a WAF skip rule for `/api/sync/*` stays the fallback if Cloudflare ever challenges the named agent too.

### The tree binding

A run proceeds only when three things agree (BRD2 section 11, SI-06):

1. The dbid (the tree's folder name) equals the `dbid` in `config.json` and in the sidecar's `meta`.
2. The tree marker, a uuid stored in the tree's own metadata under `hfy_sync_tree_id`, equals the sidecar's `tree_id`. `bind` writes it inside one `DbTxn` together with the sidecar and rolls both back if either fails; `config.json` is written last.
3. The similarity guard: at least 90 % of the sidecar's `base` handles still exist in the tree. With nothing synced yet (an empty `base`) there is nothing to compare.

Anything else is D03 (exit 78, `next_action: open_bound_tree`). The earlier hash of all handles is gone: it changed on every local create or delete. A few local creates and deletes between syncs (the tests use 8 removed and 6 created, under 10 %) leave the guard satisfied, and local creates never lower it. Replacing the tree with a different one (no marker, or the marker with most of the objects gone) does not satisfy it.

Two edges follow from the 90 % line and are by design. Deleting more than 10 % of the synced objects in Gramps between two syncs reads as a different tree and is refused until the tree is rebound; the mass-delete guard (more than 10 objects or 5 % in one run) is meant to catch a deliberate clean-up before that, in the sync run. And `bind` never moves the binding: with a `config.json` present it answers D03 for any other tree.

A tree that was re-imported, restored from a copy or exported and re-imported has a new dbid, or a marker that the sidecar does not know. It is treated as a new tree, in this order (these steps arrive with later tasks, named per step below; the skeleton only refuses it):

1. A step-up rebind: a fresh sign-in, because rebinding changes which tree the website follows. Owners: `addon-transport-auth` (the sign-in) and `addon-push` (the step-up on the push).
2. A new sidecar, so no `base` of the old tree is trusted.
3. Rebase mode (D12): objects that equal the website's copy are re-based, everything else becomes a conflict; the command line refuses, the GUI resolves, and nothing is pushed automatically. Owners: `addon-pull-apply` (the new sidecar and the rebase pass) and `addon-gui-preview` (the Gramps-window resolution).
4. The mass-delete guard on both sides for the first runs, so a tree that is missing objects cannot delete them on the website. Owners: `addon-push` (the push side) and `addon-pull-apply` (the pull side).

D12 (sidecar missing) and D13 (sidecar damaged, or written by a newer addon) are refusals with exit 78 and `next_action: rebase`; the skeleton never rebuilds a sidecar by itself.

### status.json

`<dbid>/status.json` is the sync.md 4.3 document, written atomically (temp file and rename). This build adds one key, `versions` (`addon`, `gramps`, `db_schema`, `redaction`), and two `next_action` values for the binding recoveries, `bind` and `rebase` (BRD2 D50). It carries counts and codes only, never a name, a date, a handle or a path to media. The per-run log in `logs/<run_id>.log` records step names and refusal codes and nothing else.

### Test seams

`HFY_GRAMPS_CMD` (the wrapper: the Gramps command to run, default the app bundle's executable) and `HFY_SYNC_PS_CMD` (the process list the GUI scan reads, default `ps -axo command=`) exist so tests do not depend on what is running on the machine. Neither is set in use. `HFY_SYNC_PS_CMD` is honoured only while `HFY_SYNC_TEST=1` is also set, so a stray variable cannot switch the GUI-process half of D01 off; the tree's `lock` file protects the tree either way.
