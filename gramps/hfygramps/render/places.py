"""Places the renderer never publishes (BRD2 section 11.1, 5.3; sync.md 5.3): street-level and home-like places.

The redaction projection removes them before the store holds them. The renderer applies the same rule to the store view
it is given, so a view that still holds one cannot put it on the site: the place is dropped, and every reference to it
(``Event.place``, ``Place.placeref_list[].ref``) is re-pointed to its nearest kept ancestor, or ``""`` when there is none.

Excluded: Street 7, Building 19, Number 20 and Farm 18, and a custom (or unknown) place type whose own string matches
``/house|home|residence|address|apartment|apt|lot|farm/i``.

INTERIM RULE COPY (BRD2 D2-32): ``EXCLUDED_PLACE_TYPE_CODES`` and ``HOME_LIKE_RE`` are a local copy of the rule that
``gramps/redaction/redaction-v1.json`` (``redaction-policy-v1``) will own; the test ``RuleSourceAgreement`` fails if that file
exists and disagrees. TODO(render-lambda / projection-py): import the rule instead of keeping it here.

The pattern is the spec's literal text (sync.md 5.3 as amended by BRD2 section 11.1) and is DELIBERATELY unanchored: it
matches inside a word, so ``Charlotte``, ``Adaptation`` or ``Allotment`` are excluded as well as ``Homestead`` and
``Farmhouse``. Over-exclusion fails safe (a place and its references fall back to the nearest kept ancestor), and a renderer
that matched less than the projection would publish a place the projection meant to hold back. Word boundaries would also
stop ``Homestead`` and ``Farmhouse`` matching. ``test_render_rules`` pins the behaviour either way.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, Mapping, Optional, Set

from .labels import PLACE_TYPE_LABELS, place_type

EXCLUDED_PLACE_TYPE_CODES = frozenset({7, 18, 19, 20})
HOME_LIKE_RE = re.compile(r"house|home|residence|address|apartment|apt|lot|farm", re.IGNORECASE)


def is_home_like_place(place: Mapping[str, Any]) -> bool:
    typed = place_type(place.get("place_type"))
    code = typed.get("code")
    if code in EXCLUDED_PLACE_TYPE_CODES:
        return True
    if isinstance(code, int) and code in PLACE_TYPE_LABELS:
        return False  # any other standard type is kept
    text = typed.get("string")
    return isinstance(text, str) and bool(HOME_LIKE_RE.search(text))


def _first_parent(place: Mapping[str, Any]) -> Optional[str]:
    for ref in place.get("placeref_list") or []:
        if isinstance(ref, dict) and isinstance(ref.get("ref"), str) and ref["ref"]:
            return ref["ref"]
    return None


def excluded_places(places: Mapping[str, Dict[str, Any]]) -> Set[str]:
    return {handle for handle, place in places.items() if is_home_like_place(place)}


def nearest_kept(handle: str, places: Mapping[str, Dict[str, Any]], excluded: Set[str]) -> str:
    """The first ancestor (through ``placeref_list[0]``) that is not excluded, or ``""``. Cycles end at ``""``."""

    seen: Set[str] = set()
    current: Optional[str] = handle
    while current and current in excluded and current not in seen:
        seen.add(current)
        place = places.get(current)
        current = _first_parent(place) if place else None
    if not current or current in excluded or current in seen:
        return ""
    return current


def apply_place_exclusions(places: Dict[str, Dict[str, Any]], events: Iterable[Dict[str, Any]]) -> Set[str]:
    """Drop the excluded places from ``places`` in place and re-point ``events`` and the surviving places. Returns the handles."""

    excluded = excluded_places(places)
    if not excluded:
        return excluded
    lookup = dict(places)
    for handle in excluded:
        del places[handle]
    for event in events:
        target = event.get("place")
        if isinstance(target, str) and target in excluded:
            event["place"] = nearest_kept(target, lookup, excluded)
    for place in places.values():
        refs = place.get("placeref_list")
        if not isinstance(refs, list):
            continue
        kept = []
        seen: Set[str] = set()
        for ref in refs:
            target = ref.get("ref") if isinstance(ref, dict) else None
            if isinstance(target, str) and target in excluded:
                replacement = nearest_kept(target, lookup, excluded)
                if not replacement or replacement in seen:
                    continue
                ref = {**ref, "ref": replacement}
                target = replacement
            if isinstance(target, str):
                seen.add(target)
            kept.append(ref)
        place["placeref_list"] = kept
    return excluded
