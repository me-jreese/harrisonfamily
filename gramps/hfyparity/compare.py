"""Compare a shadow render with a legacy export and return counts only (HFY-TSK-370). Standard library only.

``compare(legacy, shadow, policy)`` takes two ``{site key: source}`` maps (a source is the bytes or a ``Path`` read on demand)
and returns a plain dict of counts. It lines up the keys the render Lambda owns (``is_owned``), sorts every difference into a
class, and explains it by a rule from ``rules.RULES`` or leaves it unexplained:

* ``only_in_legacy``: the legacy export has the key and the shadow does not;
* ``only_in_render``: the shadow has the key and the legacy export does not;
* ``changed``: both have it, with different bytes; each JSON difference must be explained, or the file is unexplained.

``expect_stripped`` (``--expect-stripped <n>``, HFY-TSK-374) is the add-on's own ``counts.media_location_stripped``: the number of media the
website holds as a copy without their GPS location. Up to n media whose legacy and shadow entries both carry a checksum and a size, with
the checksum differing, are explained under ``media-location-stripped`` (the first n handles in sorted order; the report only counts). A
media beyond n stays unexplained. With ``stripped_handles`` (``--stripped-sidecar``: the handles the add-on's sidecar recorded as uploaded
without their location) only those media can be explained, so a media that differs for another reason is never taken for one. Without the
option the rule never fires.

``expect_holds`` (``--expect-holds <n>``) is the one input that is not in the two trees: the add-on's own count of objects it held
whole. Up to n whole-object absences (``only_in_legacy`` person, family, event, note, place and media files that no other rule
explains) are explained under ``held-object``, together with the index entries that left the area's index with them. A file
beyond n stays unexplained. Which files are the first n is the sorted order of their keys: the report only counts, so it only
means something as a total.

The classification is ported from ``gramps/tests/fixtures/render/deltas.py`` (``compare``, one rule: excluded-place), widened to
the other rules the design documents. Nothing here returns, prints or logs a key, an id, a name or a value: results are counters
keyed by class, rule id, area (a fixed vocabulary) and field (a fixed vocabulary of schema names).
"""

from __future__ import annotations

import json
import re
from collections import Counter
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Dict, Iterator, List, Mapping, Optional, Set, Tuple, Union

from .rules import NORMALISED, NOT_COMPARED, RULES, Policy

Source = Union[bytes, Path]

DATA_PREFIXES = ("person", "family", "event", "note", "place", "media")
#: The keys the render Lambda owns (a port of lambda/hfy-sync-render/hfy_render/keys.py, which says why).
_OWNED = re.compile(r"^(person|family|event|note|place|media)/([A-Za-z0-9][A-Za-z0-9_.-]*)\.json$")
_NOT_RENDERER_FILES = frozenset({"person/graph.json", "person/search-store.json"})
INDEX_KEYS = frozenset({"person/index.json", "person/search-index.json", "place/index.json", "media/index.json"})
AREAS = DATA_PREFIXES + ("index", "other")
CLASSES = ("only_in_legacy", "only_in_render", "changed")

#: Schema field names that may be reported for an unexplained change. Anything else is reported as ``other``.
FIELD_VOCABULARY = frozenset("""
handle grampsId displayName givenName surname gender isLiving birthYear deathYear lifespanSummary lifespan summary birth death
year place date text description label type code string role events notes raw html mediaGallery primaryPhoto title mime size
checksum s3Key missing region regions rect tags attributes value name isPrimary source citations familyTree parentFamilies
spouseFamilies children father mother frel mrel latitude longitude parents urls person count people documents generatedAt
searchText mergedInto familyTreeMedia
""".split())
#: Code words for a difference with no JSON field to name.
CODE_WORDS = ("bytes_only", "bad_json", "unowned_key", "entry_added", "entry_removed", "other")

_BARE_YEAR = re.compile(r"[0-9]{4}")


class _Missing:
    def __repr__(self) -> str:  # never reached by a report; here so a stray print shows no value
        return "<missing>"


MISSING = _Missing()


def is_owned(key: object) -> bool:
    return isinstance(key, str) and key not in _NOT_RENDERER_FILES and _OWNED.match(key) is not None


def area_of(key: str) -> str:
    if key in INDEX_KEYS:
        return "index"
    prefix = key.split("/", 1)[0]
    return prefix if prefix in DATA_PREFIXES else "other"


def not_compared_category(key: str) -> str:
    """Which part of the legacy site a key the renderer does not own belongs to."""
    parts = key.split("/")
    if key in _NOT_RENDERER_FILES:
        return "graph-file"
    if parts[0] == "uploads":
        return "uploads"
    if parts[0] == "media":
        if len(parts) > 2 and parts[1] == "faces":
            return "media-faces"
        if len(parts) > 2 and parts[1] == ".staging":
            return "media-staging"
        if len(parts) == 2 and parts[1].startswith("tree_") and parts[1].endswith(".svg"):
            return "tree-svg"
        if len(parts) == 2:
            return "media-binary"
        return "other"
    if parts[0] in DATA_PREFIXES:
        return "shell-file" if key == "person/index.html" else "other"
    return "shell-file"


def _read(source: Source) -> bytes:
    return source if isinstance(source, bytes) else source.read_bytes()


def _parse(source: Source) -> Tuple[bool, Any]:
    try:
        return True, json.loads(_read(source).decode("utf-8"))
    except (ValueError, OSError):
        return False, None


# ---- JSON differences (a port of deltas.json_diff, with a sentinel for an absent key) -------------------------------

def json_diff(a: Any, b: Any, path: tuple = ()) -> Iterator[Tuple[tuple, Any, Any]]:
    """Yield (path, a, b) for every leaf where two parsed JSON values differ. A list of another length is one change."""
    if type(a) is not type(b):
        yield path, a, b
    elif isinstance(a, dict):
        for name in sorted(set(a) | set(b)):
            if name not in a:
                yield path + (name,), MISSING, b[name]
            elif name not in b:
                yield path + (name,), a[name], MISSING
            else:
                yield from json_diff(a[name], b[name], path + (name,))
    elif isinstance(a, list):
        if len(a) != len(b):
            yield path, a, b
        else:
            for index, (x, y) in enumerate(zip(a, b)):
                yield from json_diff(x, y, path + (index,))
    elif a != b:
        yield path, a, b


def _child(node: Any, token: Any) -> Any:
    try:
        if isinstance(node, list) and isinstance(token, int):
            return node[token]
        if isinstance(node, dict) and isinstance(token, str):
            return node.get(token, MISSING)
    except IndexError:
        pass
    return MISSING


def _node(doc: Any, path: tuple) -> Any:
    node = doc
    for token in path:
        node = _child(node, token)
        if node is MISSING:
            return MISSING
    return node


def field_name(path: tuple) -> str:
    for token in reversed(path):
        if isinstance(token, str):
            return token if token in FIELD_VOCABULARY else "other"
    return "other"


def _empty(value: Any) -> bool:
    return value is MISSING or value is None or value == ""


def _subsequence(small: list, big: list) -> bool:
    it = iter(big)
    return all(any(item == other for other in it) for item in small)


# ---- the rules --------------------------------------------------------------------------------------------------------

#: The area each index file lists (a held object leaves its area's index files with it).
INDEX_AREA = {"person/index.json": "person", "person/search-index.json": "person", "place/index.json": "place",
              "media/index.json": "media"}
_HELD_BINARY_FIELDS = ("missing", "checksum", "size")


class _Context:
    def __init__(self, policy: Policy, excluded_places: Set[str], held_media: Set[str],
                 held_objects: Optional[Dict[str, Set[str]]] = None, stripped: Optional[Set[str]] = None):
        self.policy = policy
        #: the media handles the --expect-stripped allowance explains
        self.stripped: Set[str] = stripped or set()
        self.excluded = excluded_places
        self.held_media = held_media
        #: {area: the names (file stem, handle, Gramps ID) of the whole objects the --expect-holds allowance explained}
        self.held_objects: Dict[str, Set[str]] = held_objects or {}


def _is_excluded_dict(ctx: _Context, value: Any) -> bool:
    return isinstance(value, dict) and isinstance(value.get("handle"), str) and value["handle"] in ctx.excluded


def _under_excluded_place(ctx: _Context, doc: Any, path: tuple) -> bool:
    """True when the difference sits on, or below, an object of the legacy document that is an excluded place."""
    if not ctx.excluded:
        return False
    node = doc
    for token in path:
        node = _child(node, token)
        if node is MISSING:
            return False
        if _is_excluded_dict(ctx, node):
            return True
    return False


def _coordinate_rounded(policy: Policy, a: Any, b: Any) -> bool:
    if isinstance(a, bool) or _empty(a) or not isinstance(a, (int, float, str)):
        return False
    text = str(a).strip()
    if not policy.coordinate_pattern.fullmatch(text):
        return _empty(b)  # not a plain decimal: the projection blanks it
    if isinstance(b, bool) or not isinstance(b, (int, float, str)):
        return False
    try:
        before, after = Decimal(text), Decimal(str(b).strip())
    except InvalidOperation:
        return False
    rounded = before.quantize(Decimal(1).scaleb(-policy.coordinate_decimals), rounding=ROUND_HALF_UP)
    return rounded != before and after == rounded


def _same_year(doc_a: Any, doc_b: Any, date_path: tuple) -> bool:
    """True when the ``date`` object at ``date_path`` keeps the same ``year`` (or has none) on both sides."""
    date_a, date_b = _node(doc_a, date_path), _node(doc_b, date_path)
    if not (isinstance(date_a, dict) and isinstance(date_b, dict)):
        return False
    year_a, year_b = date_a.get("year", MISSING), date_b.get("year", MISSING)
    return type(year_a) is type(year_b) and year_a == year_b


def _media_object_path(key: str, parent: tuple) -> bool:
    """True when ``parent`` is a media-like object the rule covers: a media file, a media/index.json entry, or a person's
    primaryPhoto or mediaGallery[] entry."""
    if key.startswith("media/"):
        return parent == ()
    if key.startswith("person/") and key not in INDEX_KEYS:
        return parent == ("primaryPhoto",) or (len(parent) == 2 and parent[0] == "mediaGallery" and isinstance(parent[1], int))
    return False


def _held_binary(key: str, doc_a: Any, doc_b: Any, path: tuple) -> bool:
    """The whole media-held-binary pattern, read on the object that holds the differing field: the same handle on both sides, a
    legacy checksum, and in the shadow missing=true with a null checksum and a null size."""
    if not path or path[-1] not in _HELD_BINARY_FIELDS or not _media_object_path(key, path[:-1]):
        return False
    obj_a, obj_b = _node(doc_a, path[:-1]), _node(doc_b, path[:-1])
    if not (isinstance(obj_a, dict) and isinstance(obj_b, dict)):
        return False
    handle = obj_a.get("handle")
    return (isinstance(handle, str) and handle != "" and obj_b.get("handle") == handle
            and isinstance(obj_a.get("checksum"), str) and obj_a["checksum"] != ""
            and obj_b.get("missing") is True
            and "checksum" in obj_b and obj_b["checksum"] is None
            and "size" in obj_b and obj_b["size"] is None)


def _int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _stripped_pair(obj_a: Any, obj_b: Any) -> Optional[str]:
    """The media handle when two media-like objects are the media-location-stripped pattern: the same handle, a checksum and a size on
    both sides, the checksum differing, and neither side read as missing."""
    if not (isinstance(obj_a, dict) and isinstance(obj_b, dict)):
        return None
    handle = obj_a.get("handle")
    ca, cb = obj_a.get("checksum"), obj_b.get("checksum")
    if (isinstance(handle, str) and handle != "" and obj_b.get("handle") == handle
            and isinstance(ca, str) and ca != "" and isinstance(cb, str) and cb != "" and ca != cb
            and _int(obj_a.get("size")) and _int(obj_b.get("size"))
            and obj_a.get("missing") is not True and obj_b.get("missing") is not True):
        return handle
    return None


def _stripped_entry(ctx: _Context, key: str, doc_a: Any, doc_b: Any, path: tuple) -> bool:
    """A differing checksum or size of a media-like object whose handle the --expect-stripped allowance explains."""
    if not ctx.stripped or not path or path[-1] not in ("checksum", "size") or not _media_object_path(key, path[:-1]):
        return False
    handle = _stripped_pair(_node(doc_a, path[:-1]), _node(doc_b, path[:-1]))
    return handle is not None and handle in ctx.stripped


def _take_stripped(legacy_owned: Mapping[str, Source], shadow_owned: Mapping[str, Source], allowed: int,
                   only: Optional[Set[str]] = None) -> Set[str]:
    """The first ``allowed`` media handles (sorted) whose media file differs from the legacy one by the media-location-stripped pattern.
    With ``only`` (the handles the add-on's sidecar records as sent without their location) no other media is explained."""
    found: Set[str] = set()
    for key in sorted(legacy_owned):
        if len(found) >= allowed:
            break
        if not key.startswith("media/") or key in INDEX_KEYS or key not in shadow_owned:
            continue
        ok_a, doc_a = _parse(legacy_owned[key])
        ok_b, doc_b = _parse(shadow_owned[key])
        handle = _stripped_pair(doc_a, doc_b) if ok_a and ok_b else None
        if handle is not None and (only is None or handle in only):
            found.add(handle)
    return found


def explain(ctx: _Context, key: str, doc_a: Any, doc_b: Any, path: tuple, a: Any, b: Any) -> Optional[str]:
    """The rule id that explains one JSON difference, or None."""
    policy = ctx.policy
    if _under_excluded_place(ctx, doc_a, path):
        return "excluded-place"
    if isinstance(a, list) and isinstance(b, list) and len(b) < len(a):
        if [item for item in a if not _is_excluded_dict(ctx, item)] == b:
            return "excluded-place"
        if path and path[-1] in ("urls", "citations") and _subsequence(b, a):
            return "text-gate-withheld"
    leaf = path[-1] if path else None
    if key.startswith("person/") and path and path[0] == "familyTreeMedia":
        return "tree-svg-frozen"
    if leaf in ("latitude", "longitude") and _coordinate_rounded(policy, a, b):
        return "place-coordinates-rounded"
    if path == ("code",) and key.startswith("place/") and isinstance(a, str) and a and _empty(b):
        place_type = doc_a.get("type") if isinstance(doc_a, dict) else None
        code = place_type.get("code") if isinstance(place_type, dict) else None
        if isinstance(code, int) and not isinstance(code, bool) and code not in policy.administrative_codes:
            return "place-code-local"
    if _held_binary(key, doc_a, doc_b, path):
        return "media-held-binary"
    if _stripped_entry(ctx, key, doc_a, doc_b, path):
        return "media-location-stripped"
    if len(path) >= 2 and path[-2:] == ("date", "text") and isinstance(a, str) and isinstance(b, str) and a != b:
        event = _node(doc_a, path[:-2])
        if isinstance(event, dict) and policy.event_birth_like(event.get("type")):
            if b == "" and _same_year(doc_a, doc_b, path[:-1]):
                return "birth-date-scrub"      # a bare year (or a day and month) blanked, the year field kept
            if not _BARE_YEAR.fullmatch(a) and _BARE_YEAR.fullmatch(b) and b in a:
                return "birth-date-scrub"      # the day and month dropped, the bare year kept
    if leaf in ("raw", "html"):
        parent = _node(doc_a, path[:-1])
        if isinstance(parent, dict) and "raw" in parent and "html" in parent:
            if _empty(a) and isinstance(b, str) and b:
                return "note-newly-visible"
            if isinstance(a, str) and a and _empty(b):
                return "text-gate-withheld"
    if leaf == "description" and isinstance(a, str) and a and _empty(b):
        parent = _node(doc_a, path[:-1])
        if isinstance(parent, dict) and "type" in parent and "date" in parent:
            return "text-gate-withheld"
    if leaf == "title" and isinstance(a, str) and a and isinstance(b, str) and b != a:
        parent_a, parent_b = _node(doc_a, path[:-1]), _node(doc_b, path[:-1])
        if (isinstance(parent_a, dict) and ("s3Key" in parent_a or "mime" in parent_a)
                and isinstance(parent_b, dict) and b == parent_b.get("grampsId")):
            return "text-gate-withheld"
    return None


# ---- index files ------------------------------------------------------------------------------------------------------

def _split_index(doc: Any) -> Tuple[Optional[dict], Optional[list]]:
    if isinstance(doc, list):
        return None, doc
    if isinstance(doc, dict):
        for name in ("people", "documents"):
            if isinstance(doc.get(name), list):
                return {k: v for k, v in doc.items() if k != name}, doc[name]
    return None, None


def _identities(entries: list) -> List[str]:
    seen: Counter = Counter()
    out = []
    for entry in entries:
        ident = None
        if isinstance(entry, dict):
            for name in ("handle", "grampsId"):
                if isinstance(entry.get(name), str):
                    ident = name + ":" + entry[name]
                    break
        if ident is None:
            ident = "json:" + json.dumps(entry, sort_keys=True)
        seen[ident] += 1
        out.append("%s#%d" % (ident, seen[ident]))
    return out


def _removed_entry_rule(ctx: _Context, key: str, entry: Any) -> Optional[str]:
    if not isinstance(entry, dict):
        return None
    handle = entry.get("handle")
    if isinstance(handle, str):
        if key == "place/index.json" and handle in ctx.excluded:
            return "excluded-place"
        if key == "media/index.json" and handle in ctx.held_media:
            return "media-held-mime"
    names = ctx.held_objects.get(INDEX_AREA.get(key, ""))
    if names and any(isinstance(entry.get(f), str) and entry[f] in names for f in ("handle", "grampsId")):
        return "held-object"
    return None


def _compare_index(ctx: _Context, key: str, doc_a: Any, doc_b: Any) -> Tuple[Set[str], Counter, Set[str]]:
    """(rules, unexplained fields, normalised ids) for an index file whose bytes differ."""
    rules: Set[str] = set()
    fields: Counter = Counter()
    normalised: Set[str] = set()
    top_a, entries_a = _split_index(doc_a)
    top_b, entries_b = _split_index(doc_b)
    if entries_a is None or entries_b is None:
        for path, a, b in json_diff(doc_a, doc_b):
            rule = explain(ctx, key, doc_a, doc_b, path, a, b)
            if rule:
                rules.add(rule)
            else:
                fields[field_name(path)] += 1
        return rules, fields, normalised
    top_a, top_b = dict(top_a or {}), dict(top_b or {})
    if top_a.get("generatedAt") != top_b.get("generatedAt"):
        normalised.add("index-generated-at")
    top_a.pop("generatedAt", None)
    top_b.pop("generatedAt", None)
    if top_a.get("count") == len(entries_a) and top_b.get("count") == len(entries_b):
        top_a.pop("count")
        top_b.pop("count")
    for path, a, b in json_diff(top_a, top_b):
        rule = explain(ctx, key, top_a, top_b, path, a, b)
        if rule:
            rules.add(rule)
        else:
            fields[field_name(path)] += 1
    ids_a, ids_b = _identities(entries_a), _identities(entries_b)
    by_a, by_b = dict(zip(ids_a, entries_a)), dict(zip(ids_b, entries_b))
    if [i for i in ids_a if i in by_b] != [i for i in ids_b if i in by_a]:
        normalised.add("index-order")
    for ident in ids_a:
        if ident not in by_b:
            rule = _removed_entry_rule(ctx, key, by_a[ident])
            if rule:
                rules.add(rule)
            else:
                fields["entry_removed"] += 1
        elif by_a[ident] != by_b[ident]:
            for path, a, b in json_diff(by_a[ident], by_b[ident]):
                rule = explain(ctx, key, by_a[ident], by_b[ident], path, a, b)
                if rule:
                    rules.add(rule)
                else:
                    fields[field_name(path)] += 1
    for ident in ids_b:
        if ident not in by_a:
            fields["entry_added"] += 1
    return rules, fields, normalised


# ---- the comparison ---------------------------------------------------------------------------------------------------

class _Tally:
    def __init__(self) -> None:
        self.identical = 0
        self.normalised_only = 0
        self.normalised: Counter = Counter()
        self.explained = Counter()
        self.unexplained = Counter()
        self.rules: Dict[str, Dict[str, Any]] = {}
        self.unexplained_areas: Counter = Counter()
        self.unexplained_fields: Counter = Counter()
        self.not_compared: Counter = Counter()
        self.legacy_files = 0
        self.shadow_files = 0
        self.holds: Optional[Dict[str, int]] = None
        self.stripped: Optional[Dict[str, int]] = None

    def explain(self, cls: str, area: str, rules: Set[str]) -> None:
        self.explained[cls] += 1
        for rule in rules:
            entry = self.rules.setdefault(rule, {"only_in_legacy": 0, "only_in_render": 0, "changed": 0, "areas": Counter()})
            entry[cls] += 1
            entry["areas"][area] += 1

    def leave_unexplained(self, cls: str, area: str, fields: Counter) -> None:
        self.unexplained[cls] += 1
        self.unexplained_areas[area] += 1
        for name, n in fields.items():
            self.unexplained_fields[name if name in FIELD_VOCABULARY or name in CODE_WORDS else "other"] += n

    def result(self) -> Dict[str, Any]:
        explained, unexplained = sum(self.explained.values()), sum(self.unexplained.values())
        verdict = "unexplained" if unexplained else ("explained" if explained else "identical")
        out = {
            "verdict": verdict,
            "files": {"legacy": self.legacy_files, "shadow": self.shadow_files, "identical": self.identical,
                      "normalised_only": self.normalised_only},
            "classes": {cls: {"explained": self.explained[cls], "unexplained": self.unexplained[cls]} for cls in CLASSES},
            "explained": explained,
            "unexplained": unexplained,
            "rules": {rule: {"only_in_legacy": e["only_in_legacy"], "only_in_render": e["only_in_render"],
                             "changed": e["changed"], "areas": {a: e["areas"][a] for a in AREAS if e["areas"][a]}}
                      for rule, e in sorted(self.rules.items())},
            "normalised": {rid: self.normalised[rid] for rid in sorted(NORMALISED) if self.normalised[rid]},
            "unexplained_by_area": {a: self.unexplained_areas[a] for a in AREAS if self.unexplained_areas[a]},
            "unexplained_by_field": {f: n for f, n in sorted(self.unexplained_fields.items())},
            "not_compared": {c: self.not_compared[c] for c in sorted(NOT_COMPARED) if self.not_compared[c]},
        }
        if self.holds is not None:       # only when --expect-holds was given: without it the report is as it was
            out["holds"] = dict(self.holds)
        if self.stripped is not None:    # likewise for --expect-stripped
            out["stripped"] = dict(self.stripped)
        return out


def _absence_rule(key: str, source: Source, excluded: Set[str], held_media: Set[str]) -> Optional[str]:
    """The rule that explains a legacy file the shadow output lacks, from the policy alone (not the held-object allowance)."""
    ok, doc = _parse(source)
    if ok and isinstance(doc, dict) and key not in INDEX_KEYS:
        stem = key.split("/", 1)[1][:-5]
        if key.startswith("place/") and stem in excluded:
            return "excluded-place"
        if key.startswith("media/") and stem in held_media:
            return "media-held-mime"
    return None


def _take_holds(legacy_owned: Mapping[str, Source], shadow_owned: Mapping[str, Source], excluded: Set[str],
                held_media: Set[str], allowed: int) -> Tuple[Set[str], Dict[str, Set[str]]]:
    """The whole-object absences the --expect-holds allowance explains: the first ``allowed`` legacy data files (in key order)
    that the shadow output lacks and that no policy rule explains, and the names (file stem, handle, Gramps ID) by area that
    let their index entries be matched."""
    keys: Set[str] = set()
    names_by_area: Dict[str, Set[str]] = {}
    for key in sorted(legacy_owned):
        if len(keys) >= allowed:
            break
        if key in shadow_owned or key in INDEX_KEYS or _absence_rule(key, legacy_owned[key], excluded, held_media):
            continue
        keys.add(key)
        names = {key.split("/", 1)[1][:-5]}
        ok, doc = _parse(legacy_owned[key])
        if ok and isinstance(doc, dict):
            names.update(doc[f] for f in ("handle", "grampsId") if isinstance(doc.get(f), str))
        names_by_area.setdefault(area_of(key), set()).update(names)
    return keys, names_by_area


def compare(legacy: Mapping[str, Source], shadow: Mapping[str, Source], policy: Policy,
            expect_holds: Optional[int] = None, expect_stripped: Optional[int] = None,
            stripped_handles: Optional[Set[str]] = None) -> Dict[str, Any]:
    """The counts. ``legacy`` and ``shadow`` map a site key to its bytes or to a file path. ``expect_holds`` is the add-on's own
    count of objects it held whole (None: absences no policy rule explains stay unexplained). ``expect_stripped`` is its count of media
    sent without their location (None: a media whose checksum differs stays unexplained)."""
    for count in (expect_holds, expect_stripped):
        if count is not None and (isinstance(count, bool) or not isinstance(count, int) or count < 0):
            raise ValueError("expect")
    tally = _Tally()
    legacy_owned = {k: v for k, v in legacy.items() if is_owned(k)}
    shadow_owned = {k: v for k, v in shadow.items() if is_owned(k)}
    tally.legacy_files, tally.shadow_files = len(legacy_owned), len(shadow_owned)
    for key in legacy:
        if key not in legacy_owned:
            tally.not_compared[not_compared_category(key)] += 1
    for key in shadow:
        if key not in shadow_owned:
            tally.leave_unexplained("only_in_render", "other", Counter({"unowned_key": 1}))

    excluded: Set[str] = set()
    held_media: Set[str] = set()
    for key, source in legacy_owned.items():
        if key in INDEX_KEYS or key.split("/", 1)[0] not in ("place", "media"):
            continue
        ok, doc = _parse(source)
        if not ok or not isinstance(doc, dict):
            continue
        names = {key.split("/", 1)[1][:-5]}
        if isinstance(doc.get("handle"), str):
            names.add(doc["handle"])
        if key.startswith("place/") and policy.place_excluded(doc.get("type")):
            excluded |= names
        if key.startswith("media/") and doc.get("mime") in policy.held_mimes:
            held_media |= names
    held_keys: Set[str] = set()
    held_objects: Dict[str, Set[str]] = {}
    if expect_holds is not None:
        held_keys, held_objects = _take_holds(legacy_owned, shadow_owned, excluded, held_media, expect_holds)
        tally.holds = {"allowed": expect_holds, "explained": len(held_keys)}
    explained_stripped: Set[str] = set()
    if expect_stripped is not None:
        explained_stripped = _take_stripped(legacy_owned, shadow_owned, expect_stripped, stripped_handles)
        tally.stripped = {"allowed": expect_stripped, "explained": len(explained_stripped)}
    ctx = _Context(policy, excluded, held_media, held_objects, explained_stripped)

    for key in sorted(set(legacy_owned) | set(shadow_owned)):
        area = area_of(key)
        if key not in shadow_owned:
            rule = _absence_rule(key, legacy_owned[key], excluded, held_media)
            if rule is None and key in held_keys:
                rule = "held-object"
            if rule:
                tally.explain("only_in_legacy", area, {rule})
            else:
                tally.leave_unexplained("only_in_legacy", area, Counter())
        elif key not in legacy_owned:
            ok, doc = _parse(shadow_owned[key])
            if (key.startswith("person/") and key not in INDEX_KEYS and ok and isinstance(doc, dict)
                    and list(doc) == ["mergedInto"] and isinstance(doc["mergedInto"], str)):
                tally.explain("only_in_render", area, {"merged-person-stub"})
            else:
                tally.leave_unexplained("only_in_render", area, Counter())
        else:
            raw_a, raw_b = _read(legacy_owned[key]), _read(shadow_owned[key])
            if raw_a == raw_b:
                tally.identical += 1
                continue
            ok_a, doc_a = _parse(raw_a)
            ok_b, doc_b = _parse(raw_b)
            if not (ok_a and ok_b):
                tally.leave_unexplained("changed", area, Counter({"bad_json": 1}))
                continue
            normalised: Set[str] = set()
            if key in INDEX_KEYS:
                rules, fields, normalised = _compare_index(ctx, key, doc_a, doc_b)
            else:
                rules, fields = set(), Counter()
                for path, a, b in json_diff(doc_a, doc_b):
                    rule = explain(ctx, key, doc_a, doc_b, path, a, b)
                    if rule:
                        rules.add(rule)
                    else:
                        fields[field_name(path)] += 1
            if fields:
                tally.leave_unexplained("changed", area, fields)
            elif rules:
                tally.explain("changed", area, rules)
            elif normalised:
                tally.normalised_only += 1
            else:
                tally.leave_unexplained("changed", area, Counter({"bytes_only": 1}))
            for rid in normalised:
                tally.normalised[rid] += 1
    result = tally.result()
    assert set(result["rules"]) <= set(RULES)
    return result
