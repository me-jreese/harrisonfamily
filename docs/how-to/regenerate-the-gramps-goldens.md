# How to regenerate the Gramps goldens

Use this page to rebuild, or to check, the file of values that Gramps 6.0.6 itself computes for dates and for the birth and death indexes of a person. The JavaScript Gramps rules ([`api/src/records/semantics.js`](../../api/src/records/semantics.js)) are tested against it, so you regenerate it only when Gramps changes, or when a case is added.

You do not need Gramps to use the file or to verify it. You need Gramps.app only to regenerate it.

## Before you start

- **A Mac with Gramps.app 6.0.6** at `/Applications/Gramps.app`. The generator refuses any other version, because the file is version-pinned. Set `GRAMPS_BUNDLE` to the bundle's `Contents/Resources` directory if it lives elsewhere.
- **Python 3.13 on the same Mac**, for example Homebrew's `python3.13`. The bundle's libraries are built for it. The generator re-runs itself under `python3.13` when you start it with another Python, and sets `DYLD_LIBRARY_PATH` for you. Set `GRAMPS_PYTHON` to a Python 3.13 path if it is not in `/opt/homebrew/bin`, `/usr/local/bin` or `/usr/bin`.
- **No family data is read.** The inputs are synthetic and come from a fixed seed. The generator points `GRAMPSHOME` at a fresh temporary directory, so it never touches your Gramps settings or trees, and removes the directory when it exits.

## Steps

### 1. Compare a fresh run with the committed file

```sh
python3 scripts/records/gen-gramps-semantics-goldens.py --check
```

It regenerates in memory and compares byte for byte. It prints `ok: ... byte for byte` and exits `0`, or prints `DRIFT` and exits `1`. This is the check to attach as evidence, with the counts only.

### 2. Rewrite the file (only when the check reports drift, or after adding a case)

```sh
python3 scripts/records/gen-gramps-semantics-goldens.py
```

The file is [`api/test/records/fixtures/gramps-semantics.golden.json`](../../api/test/records/fixtures/gramps-semantics.golden.json). It has no timestamp, so a rerun on the same Gramps gives the same bytes. Add cases in the generator, never by editing the file: the file carries a SHA-256 of its cases, and the check in step 3 fails on a hand edit.

### 3. Verify the file without Gramps

```sh
python3 scripts/records/check_gramps_goldens.py
python3 -m unittest discover gramps/tests/unit
```

The first uses only the standard library. It checks the SHA-256 and the counts, then re-derives every Gregorian and Julian `sortval`, its validity and the settled calendar with a second, independent computation (Python's own Gregorian ordinal and the textbook Julian-day formula), and every birth and death index from the `set_birth_death_index` rule. It does not cover the Hebrew, French, Persian, Islamic and Swedish calendars, for which Gramps is the only oracle. The second command is what CI runs.

### 4. Run the consumer

```sh
cd api && npm test
```

`test/records/semantics.node-test.js` checks the JavaScript implementation against the file. A mismatch means the JavaScript rules, not the file, are wrong, unless Gramps itself changed.

## What is in the file

- `dates`: each synthetic Date as Gramps' JSON holds it (`calendar`, `modifier`, `quality`, `dateval`, `text`, `newyear`), with Gramps' answer to `Date.set()`: `valid` (Gramps raises `DateError` for a day beyond its month and the like), and when valid the `sortval` and the `calendar` it ends in (a slash date moves to the Julian calendar). Tags such as `slash`, `newyear`, `compound` and `invalid` say what a case is for.
- `birth_death`: a Person's `event_ref_list` over synthetic Events, with the `birth_ref_index` and `death_ref_index` that `DbWriteBase.set_birth_death_index` sets. `state` cases stand alone; `event_ref_list_change` and `event_type_change` cases carry a `before` and an `after`.

For how the rules use it, see [Gramps semantics](../reference/api.md#gramps-semantics) in the API reference.
