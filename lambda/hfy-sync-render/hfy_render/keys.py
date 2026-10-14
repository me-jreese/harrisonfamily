"""Which site keys the renderer owns. Everything else is never written and never deleted (BRD2 4.4, sync.md 4.2).

Owned: ``person/<gramps_id>.json``, ``person/index.json``, ``person/search-index.json``, ``family|event|note|place|media/<handle>.json``,
``place/index.json`` and ``media/index.json``. Not owned, whatever a manifest or a listing says: ``person/index.html`` (and every other
shell file), ``person/graph.json`` and ``person/search-store.json`` (the graph builder's), media binaries (``media/<handle><ext>``),
``media/faces/*`` and the tree SVGs (``media/tree_*.svg``).
"""

from __future__ import annotations

import re

DATA_PREFIXES = ("person", "family", "event", "note", "place", "media")

_OWNED = re.compile(r"^(person|family|event|note|place|media)/([A-Za-z0-9][A-Za-z0-9_.-]*)\.json$")
#: person/<name>.json files that are not person files.
_NOT_RENDERER_FILES = frozenset({"person/graph.json", "person/search-store.json"})


def is_owned_key(key: object) -> bool:
    """True when ``key`` is a key the renderer may write or delete."""

    return isinstance(key, str) and key not in _NOT_RENDERER_FILES and _OWNED.match(key) is not None


def prefix_of(key: str) -> str:
    return key.split("/", 1)[0]
