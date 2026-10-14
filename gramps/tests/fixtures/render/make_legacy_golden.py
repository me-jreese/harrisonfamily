"""Regenerate (or check) the legacy golden and the expected-delta list for the renderer parity run (HFY-TSK-229).

    HFY_LEGACY_PROJECT=<project> python3.12 gramps/tests/fixtures/render/make_legacy_golden.py          # rewrite
    HFY_LEGACY_PROJECT=<project> python3.12 gramps/tests/fixtures/render/make_legacy_golden.py --check  # write nothing

``<project>`` is io's out-of-repo project (the folder that holds ``scripts/etl`` and ``scripts/search``): the live ETL with
the D-02 fixes, and ``build_search_index.js``. Worker-local only; CI never runs this, it runs the unit tests against the
committed output. Needs python3.12 or later and node. The live project is only read.

Writes, beside this file:

    golden/legacy/<s3 key>        what the live ETL and build_search_index.js write for P(fixture), JSON files only
    golden/legacy-source.json     sha256 of the live files the golden came from (so drift is visible)
    expected-deltas.json          every difference between that output and render_site(P(fixture)), each with its rule

It refuses to write when a difference has no rule (see deltas.py).
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.dont_write_bytecode = True

import deltas  # noqa: E402
import legacy_etl  # noqa: E402
import parity  # noqa: E402
from hfygramps.render import render_site  # noqa: E402

GOLDEN = os.path.join(HERE, "golden", "legacy")
SOURCE = os.path.join(HERE, "golden", "legacy-source.json")
DELTAS = os.path.join(HERE, "expected-deltas.json")


def build(project_root):
    raw = parity.load_jsonl() + parity.supplement()
    objects = parity.project(raw)
    held_blobs = [o["path"] for o in objects if o["_class"] == "Media" and o.get("gramps_id") in parity.HELD_BLOB_MEDIA_IDS]
    legacy = legacy_etl.run_legacy(project_root, objects, parity.MEDIA_DIR, held_blobs)
    render = render_site(objects, media_files=parity.media_files(objects), generated_at=legacy_etl.FIXED_AT)
    excluded = sorted(o["handle"] for o in objects if o["_class"] == "Place" and _excluded(o))
    result = deltas.compare(legacy, render, set(excluded))
    held = parity.held_handles(raw)
    document = {
        "version": 1,
        "about": "Every difference between the live ETL (plus build_search_index.js) and hfygramps.render on P(fixture). "
                 "Written by make_legacy_golden.py; checked by test_render_parity.py.",
        "normalised": deltas.NORMALISED,
        "event_order": deltas.EVENT_ORDER,
        "rules": deltas.RULES,
        "excluded_places": sorted(o.get("gramps_id") for o in objects if o["handle"] in set(excluded)),
        "no_delta_cases": deltas.no_delta_cases(raw, objects, held, legacy, render),
        "only_in_legacy": result["only_in_legacy"],
        "changed": result["changed"],
        "only_in_render": result["only_in_render"],
        "unexplained": result["unexplained"],
    }
    return legacy, document


def _excluded(place):
    from hfygramps.render.places import is_home_like_place
    return is_home_like_place(place)


def dumps(value):
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def tree_on_disk():
    out = {}
    for base, _dirs, names in os.walk(GOLDEN):
        for name in names:
            path = os.path.join(base, name)
            with open(path, "rb") as fh:
                out[os.path.relpath(path, GOLDEN).replace(os.sep, "/")] = fh.read()
    return out


def main(argv):
    check = "--check" in argv
    project = os.environ.get("HFY_LEGACY_PROJECT")
    if not project or not os.path.isdir(os.path.join(project, "scripts", "etl")):
        print("Set HFY_LEGACY_PROJECT to the live project folder (it holds scripts/etl and scripts/search).", file=sys.stderr)
        return 2
    legacy, document = build(project)
    if document["unexplained"]:
        print("Differences with no rule (add one to deltas.RULES or fix the renderer):", file=sys.stderr)
        for entry in document["unexplained"]:
            print("  %s %s" % (entry["key"], entry.get("kind")), file=sys.stderr)
        return 1
    document.pop("unexplained")
    provenance = {"about": "sha256 of the live ETL files the legacy golden came from.", "files": legacy_etl.provenance(project)}
    wanted = {"expected-deltas.json": dumps(document), "golden/legacy-source.json": dumps(provenance)}
    for key, data in legacy.items():
        wanted["golden/legacy/" + key] = data
    have = {}
    for rel in list(wanted):
        path = os.path.join(HERE, rel)
        if os.path.exists(path):
            with open(path, "rb") as fh:
                have[rel] = fh.read()
    stale = [rel for rel, data in wanted.items() if have.get(rel) != data]
    extra = [rel for rel in ("golden/legacy/" + k for k in tree_on_disk()) if rel not in wanted]
    if check:
        for rel in stale + extra:
            print("differs: " + rel, file=sys.stderr)
        print("golden is %s" % ("up to date" if not (stale or extra) else "STALE"))
        return 1 if (stale or extra) else 0
    for rel in extra:
        os.remove(os.path.join(HERE, rel))
    for rel in stale:
        path = os.path.join(HERE, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(wanted[rel])
    print("wrote %d files, removed %d, %d unchanged" % (len(stale), len(extra), len(wanted) - len(stale)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
