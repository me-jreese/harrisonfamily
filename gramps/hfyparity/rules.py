"""The explained differences, by rule id, and the policy lists they read (HFY-TSK-370). Standard library only.

A difference between the shadow render and a legacy export is *explained* only when a rule written here names it. The rule
ids and their sources come from the design, and the first one keeps the name it has in
``gramps/tests/fixtures/render/deltas.py`` (``RULES``). Nothing else is invented: a difference no rule names is
``unexplained``, which is the safe direction (io looks at it).

``held-object`` is the one rule that cannot be told from the output alone: the add-on's own held-object count is given with
``--expect-holds <n>``, and up to n whole-object absences are explained under it (see ``compare.compare``).

``NORMALISED`` are not differences. They are the run-to-run noise ``deltas.py`` lists under ``NORMALISED``: the ``generatedAt``
stamp and the order of index entries. They are counted on their own line and never change the exit code.

The lists the rules read (excluded place types, birth-like event types, held media types, administrative place types, the
coordinate precision) are read from ``gramps/redaction/redaction-v1.json``, the one source of the redaction rules (BRD2
D2-32). The place-type codes that Gramps itself defines are the one list kept here.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, FrozenSet, List

RULES: Dict[str, Dict[str, str]] = {
    "excluded-place": {
        "summary": "The renderer never publishes a street-level or home-like place. Its place file is not written, it leaves "
                   "place/index.json, and every event or place reference to it is re-pointed to the nearest kept ancestor. "
                   "The legacy export publishes all of them. The excluded places are the legacy place files whose type "
                   "matches the policy.",
        "source": "BRD2 11.1 (5.3), sync.md 5.3, D2-32, Q2-02 item 2; deltas.py RULES",
    },
    "media-held-mime": {
        "summary": "A Media object whose type the policy holds whole (a PDF) has no media/<handle>.json and no entry in "
                   "media/index.json in the shadow output.",
        "source": "Q2-02 item 6, sync.md 5.5, redaction-v1.json media.heldMime",
    },
    "birth-date-scrub": {
        "summary": "A birth-like event carries no day or month in the shadow output: the date text is a bare year or empty "
                   "where the legacy export had more, or empty where it had a bare year (the year field is kept, unchanged). "
                   "Seen on the event file and on the matching person.events[] entry.",
        "source": "Q2-02 item 1, sync.md 5.2, redaction-v1.json birthLike",
    },
    "media-held-binary": {
        "summary": "A Media object whose binary the add-on held, or whose original is missing, reads missing=true with a null "
                   "checksum and size in the shadow output, where the legacy export had a checksum (same handle, other fields "
                   "equal). Seen on the media file, its media/index.json entry and a person's primaryPhoto and mediaGallery[].",
        "source": "sync.md 5.5, BRD2 11.1",
    },
    "held-object": {
        "summary": "An object the add-on held whole (for example rule scan.phone) has a legacy file and no shadow file, and its "
                   "entry is gone from the area's index. Counted only under --expect-holds <n>, which allows up to n such "
                   "absences (person, family, event, note, place or media files); more than n stay unexplained.",
        "source": "sync.md 5.4 (a new object is held whole), 5.5, BRD2 11.1",
    },
    "place-coordinates-rounded": {
        "summary": "A place's latitude and longitude are rounded to two decimals in the shadow output (a value that is not a "
                   "plain decimal is blanked).",
        "source": "BRD2 11.1 (PS-15), Q2-02 item 2, redaction-v1.json places.coordinateDecimals",
    },
    "place-code-local": {
        "summary": "A place code (a postal code) below the administrative level is blank in the shadow output.",
        "source": "BRD2 11.1 (PS-15), Q2-02 item 2, redaction-v1.json places.administrativeTypes",
    },
    "note-newly-visible": {
        "summary": "A note whose text the legacy export left empty has text in the shadow output. This is the exposure change "
                   "io reviews: the renderer publishes what the store holds, behind the text gate.",
        "source": "sync.md 11.3 (last paragraph), deltas.py RENDERER_ONLY",
    },
    "text-gate-withheld": {
        "summary": "The renderer's text gate withholds free text the legacy export published as written: note text, an event "
                   "description, a media title (it falls back to the Gramps ID), a place URL or a citation title.",
        "source": "deltas.py RENDERER_ONLY, sync.md 5.3 and 5.4",
    },
    "tree-svg-frozen": {
        "summary": "The family-tree SVGs are legacy and frozen: the renderer does not own media/tree_*.svg, so a person's "
                   "familyTreeMedia differs from the legacy export.",
        "source": "sync.md 11.5, BRD2 D2-25",
    },
    "merged-person-stub": {
        "summary": "The shadow output holds person/<old id>.json = {mergedInto} for a retired Person id. The legacy export "
                   "has no such file.",
        "source": "docs/reference/sync-render.md (Merged-person stubs), HFY-TSK-281",
    },
}

NORMALISED: Dict[str, str] = {
    "index-generated-at": "The generatedAt stamp of an index file differs (the legacy run stamps its own time).",
    "index-order": "The entries of an index file come in another order (the legacy ETL lists entries in set-iteration or "
                   "directory order; the renderer sorts them).",
}

#: The categories of a legacy file the renderer does not own. They are counted, never compared (sync-render.md, Key ownership).
NOT_COMPARED: Dict[str, str] = {
    "media-binary": "media binaries (media/<handle><ext>)",
    "media-faces": "media/faces/*",
    "tree-svg": "the family-tree SVGs (media/tree_*.svg)",
    "media-staging": "media/.staging/*",
    "graph-file": "person/graph.json and person/search-store.json (the graph builder's)",
    "shell-file": "the page shell and every other file outside the data prefixes",
    "uploads": "uploads/*",
    "other": "any other file the renderer does not own",
}

#: Gramps defines place types -1 (unknown) and 1 to 20. Any other code is a custom type, matched by its own string.
STANDARD_PLACE_TYPE_CODES: FrozenSet[int] = frozenset([-1] + list(range(1, 21)))

POLICY_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "redaction", "redaction-v1.json")


class Policy:
    """The redaction lists the rules read, from ``redaction-v1.json``."""

    def __init__(self, doc: Dict[str, Any]):
        places, media, birth = doc["places"], doc["media"], doc["birthLike"]
        self.excluded_place_codes: FrozenSet[int] = frozenset(int(t["value"]) for t in places["excludedTypes"])
        self.administrative_codes: FrozenSet[int] = frozenset(int(t["value"]) for t in places["administrativeTypes"])
        self.home_like = _compile(places["customHomeLike"])
        self.coordinate_decimals: int = int(places["coordinateDecimals"])
        self.coordinate_pattern = re.compile(places["coordinatePattern"])
        self.held_mimes: FrozenSet[str] = frozenset(media["heldMime"])
        self.birth_codes: FrozenSet[int] = frozenset(int(t["value"]) for t in birth["eventTypes"])
        self.birth_custom = _compile(birth["customType"])

    def place_excluded(self, place_type: Any) -> bool:
        """True for a place the renderer never publishes, from the ``type {code, string}`` of its legacy file."""
        if not isinstance(place_type, dict):
            return False
        code, text = place_type.get("code"), place_type.get("string")
        if isinstance(code, bool) or not isinstance(code, int):
            return False
        if code in self.excluded_place_codes:
            return True
        if code in STANDARD_PLACE_TYPE_CODES:
            return False
        return isinstance(text, str) and bool(self.home_like.search(text))

    def event_birth_like(self, event_type: Any) -> bool:
        """True for a birth-like event type (``type {code, string}``). The ``birth_ref_index`` case needs the tree and is not seen."""
        if not isinstance(event_type, dict):
            return False
        code, text = event_type.get("code"), event_type.get("string")
        if isinstance(code, bool) or not isinstance(code, int):
            return False
        if code in self.birth_codes:
            return True
        return code == 0 and isinstance(text, str) and bool(self.birth_custom.search(text))


def _compile(spec: Dict[str, Any]) -> "re.Pattern[str]":
    flags = re.IGNORECASE if "i" in str(spec.get("flags", "")) else 0
    return re.compile(spec["pattern"], flags)


def load_policy(path: str = POLICY_PATH) -> Policy:
    with open(path, encoding="utf-8") as fh:
        return Policy(json.load(fh))


def rule_ids() -> List[str]:
    return sorted(RULES)
