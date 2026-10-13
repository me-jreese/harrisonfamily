# gramps

Code and tests for the Gramps side of the sync design (HFY-PLN-002). This directory holds the synthetic fixture tree and its test lane only so far; later tasks add `hfygramps/`, the addon and the schema export beside it.

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
| `media/` | The four tiny files the Media objects point at: a JPEG with EXIF GPS, a plain JPEG, a zero-byte placeholder and a PDF. |
| `census.py` | Standard-library census of the cases, shared by the generator and the unit test. |

The tree covers every case in the sync design's testing section and the review scenarios: full birth dates, baptism (deceased, with a day), christening, blessing and stillbirth events, RANGE, SPAN and TEXTONLY dates, a Birth event the review retypes to Residence, a citation of a birth event with a full date, a birth-name `Name.date`, a birth-certificate PDF, private objects and private secondary elements (a private person with an exclusive birth event, note and photo, a private family, a private ChildRef), a Farm place, a custom `Home` place, a place with 6-decimal coordinates, a street place with `alt_loc` fields, addresses, email and contact-channel Urls, phones and emails in notes, styled note tags, AGE, SSN, TIME and merged-ID attributes, every father and mother child relation, every family type, two tags of one person in one photo, a `[0,0,100,100]` rect and a float rect, and a zero-byte media file. `census.py` lists every case by name.

Two Gramps behaviours to know. The XML exporter floors float rects and drops a `[0,0,100,100]` rect, so those two cases live in the JSONL only. Handles, change times and the XML `created` date are fixed, so a regeneration is byte-identical.

### Regenerate or check

```bash
gramps/tests/gramps/gramps-shim.sh --script gramps/tests/fixtures/make_synthetic_tree.py          # rewrite the files and the D-03 allowlist lines
gramps/tests/gramps/gramps-shim.sh --script gramps/tests/fixtures/make_synthetic_tree.py --check  # byte comparison, writes nothing
```

Commit all of the changed files together. The seed (`SEED`) and `FIXED_TS` in the generator are the only inputs besides the Gramps version.

### Check without Gramps

```bash
python3 -m unittest discover gramps/tests/unit
```

This verifies the goldens against `synthetic-tree.sha256`, runs the census, cross-checks the XML against the JSONL, scans every string for anything not obviously fictional, checks the GPS EXIF bytes and checks the allowlist hashes. A worker with no Gramps installed can write tests against the goldens and trust them. The one test that regenerates the files skips when `/Applications/Gramps.app` is absent (set `HFY_GRAMPS_APP` for another path, `HFY_SKIP_REGEN=1` to skip it).

## The bundled-Gramps shim

`gramps/tests/gramps/gramps-shim.sh` runs a Python file or the Gramps CLI inside the interpreter embedded in `Gramps.app`. It builds a throwaway bundle that symlinks the real libraries, copies and re-signs the small launcher executable, and swaps in a launcher that runs your script. Nothing in `/Applications` changes. It can also install an audit hook (`HFY_SHIM_FORBID`) that refuses and logs any open of a forbidden path.

## The Gramps integration lane

```bash
gramps/tests/gramps/run.sh            # every test_*.py in that directory
gramps/tests/gramps/run.sh test_template_tree.py
```

`run.sh` makes a temporary `GRAMPSHOME` and `HOME`, imports the fixture once into a template tree with the Gramps CLI, copies that tree for each test file, and runs the test against its own copy. It then checks that the template did not change. It never reads `~/Library/Application Support/gramps/grampsdb`: every step runs under the audit hook with that folder forbidden, a negative control proves the hook blocks it, and the script fails if a violation is logged or the hook saw no file access at all. `fixture_trees.py` is the stdlib helper tests use to find and copy trees.

The lane needs a Mac with Gramps 6.0.6 (the `io-mac-gramps` runner). CI does not run it.
