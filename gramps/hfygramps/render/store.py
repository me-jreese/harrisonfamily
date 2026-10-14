"""The in-memory store view the renderer reads (a pure replacement for the live ETL's SQLite ``GrampsRepository``).

``objects`` is the redaction projection's output, ``{handle: Gramps-6 json_data object}`` (every object carries its
``_class``), or any iterable of such objects (the fixture's JSONL lines). Classes the site does not render (Tag,
Repository, ...) are ignored. The view deep-copies what it is given, so the caller's objects are never touched.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, Iterable, Iterator, List, Mapping, Optional, Set, Tuple, Union

from . import places as place_rules

#: Gramps class name -> the table name the transforms use.
TABLES = {
    "Citation": "citation",
    "Event": "event",
    "Family": "family",
    "Media": "media",
    "Note": "note",
    "Person": "person",
    "Place": "place",
    "Source": "source",
}

Objects = Union[Mapping[str, Mapping[str, Any]], Iterable[Mapping[str, Any]]]


def _iter_objects(objects: Objects) -> Iterator[Mapping[str, Any]]:
    if isinstance(objects, Mapping):
        for key in sorted(objects):
            yield objects[key]
    else:
        yield from objects


def _gramps_id(obj: Mapping[str, Any]) -> str:
    value = obj.get("gramps_id")
    return value.strip() if isinstance(value, str) else ("" if value is None else str(value).strip())


class Store:
    """``fetch(table, handle)`` and ``iter_person_handles()``, the two reads the transforms need."""

    def __init__(self, objects: Objects) -> None:
        self._tables: Dict[str, Dict[str, Dict[str, Any]]] = {table: {} for table in TABLES.values()}
        for obj in _iter_objects(objects):
            if not isinstance(obj, Mapping):
                continue
            table = TABLES.get(obj.get("_class"))
            handle = obj.get("handle")
            if table is None or not isinstance(handle, str) or not handle:
                continue
            self._tables[table][handle] = copy.deepcopy(dict(obj))
        # Street-level and home-like places never reach the site, and what pointed at them is re-pointed (places.py).
        self.excluded_places: Set[str] = place_rules.apply_place_exclusions(
            self._tables["place"], self._tables["event"].values()
        )

    def fetch(self, table: str, handle: Any) -> Optional[Dict[str, Any]]:
        if table not in self._tables:
            raise ValueError(f"Unsupported table '{table}'")
        if not isinstance(handle, str) or not handle:
            return None
        return self._tables[table].get(handle)

    def iter_person_handles(self) -> List[Tuple[str, str]]:
        """``(handle, gramps_id)`` for every person, in (gramps_id, handle) order: the same order on every run."""

        rows = [(handle, _gramps_id(person)) for handle, person in self._tables["person"].items()]
        rows.sort(key=lambda row: (row[1], row[0]))
        return rows
