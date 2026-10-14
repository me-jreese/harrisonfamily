"""`person/index.json` and `person/search-index.json`: the Python port of ``scripts/search/build_search_index.js``.

The JavaScript original reads the rendered person files and writes the search manifest (it overwrites the ETL's own
``person/index.json``) and the search documents. This port keeps its shapes, its key order and its serialisation
(``JSON.stringify(value, null, 2)``: insertion order, raw UTF-8), and takes ``generated_at`` from the caller instead of
the clock, so a re-render is byte-stable.

``person_files`` is ``{"I0001.json": parsed person JSON}``. Like the original, the files are visited in file-name order
(the original gets the operating system's directory order, which is name order on the machines it ran on), and
``index.json`` / ``search-index.json`` / ``search-store.json`` are not person files.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Mapping, Optional

NON_PERSON_FILES = frozenset({"index.json", "search-index.json", "search-store.json"})


def _get(obj: Any, *path: str) -> Any:
    current = obj
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def build_manifest_entry(person: Mapping[str, Any]) -> Dict[str, Any]:
    """`buildManifestEntry`: ``a?.b ?? null`` keeps ``""`` and ``0``; ``a || b || null`` does not."""

    birth_year = _get(person, "lifespan", "birth", "year")
    death_year = _get(person, "lifespan", "death", "year")
    lifespan_summary = _get(person, "lifespan", "summary")
    primary_photo = _get(person, "primaryPhoto", "s3Key") or _get(person, "primaryPhoto", "placeholderImage") or None
    return {
        "handle": person.get("handle"),
        "grampsId": person.get("grampsId"),
        "displayName": person.get("displayName"),
        "givenName": person.get("givenName"),
        "surname": person.get("surname"),
        "isLiving": person.get("isLiving"),
        "birthYear": birth_year,
        "deathYear": death_year,
        "lifespanSummary": lifespan_summary,
        "primaryPhoto": primary_photo,
    }


def build_search_text(entry: Mapping[str, Any]) -> str:
    """`buildSearchText`: the non-empty parts joined by a space, lower-cased."""

    parts: List[Any] = [entry.get("displayName"), entry.get("givenName"), entry.get("surname"), entry.get("grampsId")]
    if entry.get("birthYear"):
        parts.append(str(entry["birthYear"]))
    if entry.get("lifespanSummary"):
        parts.append(entry["lifespanSummary"])
    return " ".join(part for part in parts if part).lower()


def _js_json(value: Any) -> bytes:
    return json.dumps(value, indent=2, ensure_ascii=False).encode("utf-8")


def build_search_files(person_files: Mapping[str, Mapping[str, Any]], generated_at: str) -> Dict[str, bytes]:
    names = sorted(name for name in person_files if name.endswith(".json") and name not in NON_PERSON_FILES)
    entries = [build_manifest_entry(person_files[name]) for name in names]
    documents = [{"grampsId": entry["grampsId"], "searchText": build_search_text(entry)} for entry in entries]
    return {
        "person/search-index.json": _js_json({"generatedAt": generated_at, "documents": documents}),
        "person/index.json": _js_json({"count": len(entries), "generatedAt": generated_at, "people": entries}),
    }
