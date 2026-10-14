"""The expected-delta list between the live ETL's output and the renderer's, on P(fixture) (HFY-TSK-229). Standard library only.

``compare(legacy, render, excluded)`` lines up two ``{s3_key: bytes}`` trees and returns every difference as data:

* a key only the live ETL writes (``only_in_legacy``) or only the renderer writes (``only_in_render``);
* a key both write with different bytes (``changed``), as a list of RFC 6901 pointers with the legacy and the renderer value.

Every difference must be explained by a rule in ``RULES``. A difference no rule explains is reported as ``unexplained`` and
fails the golden test, so nothing slips into the list by being generated: the rule is written here, by hand.

``expected-deltas.json`` is the committed result for P(fixture). The test recomputes the comparison and requires equality.
"""

import json

RULES = {
    "excluded-place": {
        "summary": "The renderer never publishes a street-level or home-like place (Street, Building, Number, Farm, or a "
                   "custom type matching house|home|residence|address|apartment|apt|lot|farm). Its place file is not written, "
                   "it leaves place/index.json, and every event or place reference to it is re-pointed to the nearest kept "
                   "ancestor. The live ETL publishes all of them.",
        "reference": "BRD2 section 11.1 (5.3), sync.md 5.3, D2-32, Q2-02 item 2",
    },
}

NORMALISED = [
    "generatedAt: build_search_index.js stamps new Date(); the legacy run fixes it to the same value the renderer is given.",
    "Directory order: build_search_index.js reads fs.readdirSync unsorted; the legacy run sorts it (name order), as the renderer does.",
    "place/index.json and media/index.json: the live ETL lists entries in set-iteration order (it depends on PYTHONHASHSEED); "
    "both sides are sorted by (grampsId, handle).",
    "Media blobs: the live ETL copies the binaries and the renderer never writes them; only the JSON files are compared.",
]

EVENT_ORDER = ("Events are ordered by the legacy key (date.sortval, label), ties in input order, for persons and for "
               "families. sortval orders them and is never published. No difference from the live ETL.")


def json_diff(a, b, pointer=""):
    """Yield (pointer, a, b) for every leaf where two parsed JSON values differ. A list of another length is one change."""
    if type(a) is not type(b):
        yield pointer, a, b
    elif isinstance(a, dict):
        for key in sorted(set(a) | set(b)):
            sub = pointer + "/" + key.replace("~", "~0").replace("/", "~1")
            if key not in a:
                yield sub, None, b[key]
            elif key not in b:
                yield sub, a[key], None
            else:
                yield from json_diff(a[key], b[key], sub)
    elif isinstance(a, list):
        if len(a) != len(b):
            yield pointer, a, b
        else:
            for index, (x, y) in enumerate(zip(a, b)):
                yield from json_diff(x, y, f"{pointer}/{index}")
    elif a != b:
        yield pointer, a, b


def _unescape(token):
    return token.replace("~1", "/").replace("~0", "~")


def _at(doc, pointer):
    node = doc
    for token in pointer.split("/")[1:]:
        token = _unescape(token)
        node = node[int(token)] if isinstance(node, list) else node[token]
    return node


def _owner_handle(doc, pointer):
    """The `handle` of the deepest object on the pointer's path that has one and is not the document itself."""
    tokens = pointer.split("/")[1:]
    found = None
    for depth in range(1, len(tokens)):
        try:
            node = _at(doc, "/" + "/".join(tokens[:depth]))
        except (KeyError, IndexError, ValueError):
            break
        if isinstance(node, dict) and isinstance(node.get("handle"), str):
            found = node["handle"]
    return found


def _manifest_changes(legacy_doc, render_doc):
    """place/index.json and media/index.json are lists of entries keyed by handle."""
    old = {e["handle"]: e for e in legacy_doc}
    new = {e["handle"]: e for e in render_doc}
    changes = []
    for handle in sorted(set(old) | set(new)):
        if handle not in new:
            changes.append({"entry": handle, "legacy": old[handle], "render": None})
        elif handle not in old:
            changes.append({"entry": handle, "legacy": None, "render": new[handle]})
        elif old[handle] != new[handle]:
            changes.append({"entry": handle, "legacy": old[handle], "render": new[handle]})
    return changes


def compare(legacy, render, excluded_places):
    """The full difference list. ``excluded_places`` are the handles the renderer excludes."""
    only_legacy, only_render, changed, unexplained = [], [], [], []
    for key in sorted(set(legacy) | set(render)):
        if key not in render:
            handle = key.split("/", 1)[1][:-5]
            if key.startswith("place/") and handle in excluded_places:
                only_legacy.append({"key": key, "rule": "excluded-place"})
            else:
                unexplained.append({"key": key, "kind": "only_in_legacy"})
        elif key not in legacy:
            unexplained.append({"key": key, "kind": "only_in_render"})
        elif legacy[key] != render[key]:
            old, new = json.loads(legacy[key]), json.loads(render[key])
            if key in ("place/index.json", "media/index.json"):
                changes = _manifest_changes(old, new)
                explained = key == "place/index.json" and bool(changes) and all(
                    c["entry"] in excluded_places and c["render"] is None for c in changes)
                if explained:
                    changed.append({"key": key, "rule": "excluded-place", "changes": changes})
                else:
                    unexplained.append({"key": key, "kind": "changed", "changes": changes})
                continue
            changes, rules = [], set()
            for pointer, a, b in json_diff(old, new):
                owner = _owner_handle(old, pointer)
                rules.add("excluded-place" if owner in excluded_places else None)
                changes.append({"pointer": pointer, "legacy": a, "render": b})
            if rules == {"excluded-place"}:
                changed.append({"key": key, "rule": "excluded-place", "changes": changes})
            else:
                unexplained.append({"key": key, "kind": "changed", "changes": changes})
    return {"only_in_legacy": only_legacy, "changed": changed, "only_in_render": only_render, "unexplained": unexplained}


REFERENCING_CLASSES = ("Event", "Note", "Media", "Family")


def _mentions(obj, handle):
    return handle in json.dumps(obj, sort_keys=True)


def no_delta_cases(raw, projected, held, legacy, render):
    """Redaction cases that need no delta because both sides leave the object out, as Gramps IDs, plus the proof of absence.

    ``raw``: the tree before the stand-in projection; ``projected``: P(fixture); ``held``: the handles the projection holds.
    Returns ``{case: [gramps ids]}`` and raises AssertionError if any object in a case shows in either output.
    """
    outputs = [b"".join(tree[k] for k in sorted(tree)).decode("utf-8") + "\n".join(sorted(tree)) for tree in (legacy, render)]

    def absent(obj):
        return all(obj["handle"] not in text for text in outputs)

    private = [o for o in raw if o.get("private") and "gramps_id" in o]
    held_objects = [o for o in raw if o["handle"] in held]
    present = {o["handle"] for o in projected}
    kept = [o for o in projected if o["handle"] in present]
    orphans, gated = [], []
    for obj in kept:
        if obj["_class"] not in REFERENCING_CLASSES or not absent(obj):
            continue
        referrers = [o for o in kept if o["handle"] != obj["handle"] and _mentions(o, obj["handle"])]
        in_raw = [o for o in raw if o["handle"] != obj["handle"] and _mentions(o, obj["handle"])]
        if not referrers and in_raw:
            orphans.append(obj)
        elif referrers and obj["_class"] == "Note":
            gated.append(obj)  # a public note both sides withhold: the text gate (day-precise date, contact data)
    cases = {
        "private": sorted(o["gramps_id"] for o in private),
        "held": sorted(o["gramps_id"] for o in held_objects),
        "orphan_of_private": sorted(o["gramps_id"] for o in orphans),
        "withheld_by_text_gate": sorted(o["gramps_id"] for o in gated),
    }
    for objs in (private, held_objects, orphans, gated):
        for obj in objs:
            assert absent(obj), "%s %s is in an output" % (obj["_class"], obj.get("gramps_id"))
    return cases
