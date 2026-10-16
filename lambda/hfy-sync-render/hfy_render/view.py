"""The store view the renderer reads: every record head, folded from ``SYNC#LOG`` (sync.md 4.1, 7.4; the Python twin of ``StoreView`` in
``api/src/records/index.js``).

Correctness never rests on the GSI or on a cache: a pass folds the whole log up to the head seq it read with a consistent GetItem
(the redaction expunge nulls ``obj_json`` in place, so a cached view could keep what the store has dropped). Folding keeps only the
newest entry of each object, so memory is one JSON string per object, parsed once at the end.

Rendering in a pass also needs to know *what changed since the last pass* (``seq_from`` .. ``seq_to``). The fold records, for every
object touched in that range, the entry's op, its principal and origin, and the object as it was before the range began.
"""

from __future__ import annotations

import hashlib
import json
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple

from .refs import collect_refs

CLASSES = ("Person", "Family", "Event", "Place", "Source", "Citation", "Repository", "Media", "Note", "Tag")
Key = Tuple[str, str]

#: Ops that move a head. A ``marker`` only advances the seq (it wakes the renderer when a push session closes).
HEAD_OPS = ("create", "update", "delete", "withdraw")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass
class Head:
    cls: str
    handle: str
    gramps_id: str
    version: int
    seq: int
    deleted: bool
    obj_json: Optional[str]
    op: str
    at: Optional[str] = None
    origin: Optional[str] = None
    principal: Optional[str] = None
    reason: Optional[str] = None
    hash: Optional[str] = None

    @property
    def key(self) -> Key:
        return (self.cls, self.handle)


@dataclass
class Touched:
    """What the range since the last pass did to one object."""

    key: Key
    op: str
    gramps_id: str
    prev_json: Optional[str]  # the object before the range began (None if it did not exist)
    seq: int


@dataclass
class StoreView:
    heads: Dict[Key, Head] = field(default_factory=dict)
    seq: int = 0
    last_at: Optional[str] = None
    track_after: Optional[int] = None  # entries with seq > track_after are recorded in ``touched``
    touched: Dict[Key, Touched] = field(default_factory=dict)
    principals: Set[str] = field(default_factory=set)
    origins: Set[str] = field(default_factory=set)
    range_entries: int = 0
    #: Objects whose newest log entry does not hash to its own ``hash`` (catalog S15). Such an entry is skipped: the object stays as the
    #: entry before it left it (or absent), the pass goes on, and the engine alarms. A later good entry for the object clears it.
    corrupt: Dict[Key, int] = field(default_factory=dict)

    def fold(self, item: Dict[str, Any]) -> None:
        """Folds one SYNC#LOG item. Entries must arrive in ascending seq order."""

        seq = int(item["seq"])
        op = item.get("op")
        in_range = self.track_after is not None and seq > self.track_after
        if seq > self.seq:
            self.seq = seq
            self.last_at = item.get("at") or self.last_at
        if op not in HEAD_OPS:
            return
        cls, handle = item.get("class"), item.get("handle")
        if not isinstance(cls, str) or not isinstance(handle, str) or not handle:
            return
        key = (cls, handle)
        old = self.heads.get(key)
        if old is not None and seq <= old.seq:
            return  # a duplicate or out-of-order replay never moves a head back
        live = op in ("create", "update") and item.get("obj_json") is not None
        if live and isinstance(item.get("hash"), str) and item["hash"] != sha256_hex(str(item["obj_json"]).encode("utf-8")):
            self.corrupt[key] = seq  # S15: the entry's object is not the one it hashes to; the head stays as it was
            return
        self.corrupt.pop(key, None)
        gid = item.get("gramps_id")
        if in_range:
            self.range_entries += 1
            if isinstance(item.get("principal"), str) and item["principal"]:
                self.principals.add(item["principal"])
            if isinstance(item.get("origin"), str) and item["origin"]:
                self.origins.add(item["origin"])
            if key not in self.touched:
                prev = old.obj_json if old is not None and not old.deleted else None
                prev_gid = old.gramps_id if old is not None else ""
                self.touched[key] = Touched(key, op, gid or prev_gid or "", prev, seq)
            else:
                t = self.touched[key]
                t.op, t.seq = op, seq
                if gid:
                    t.gramps_id = gid
        self.heads[key] = Head(
            cls=cls, handle=handle, gramps_id=(gid if isinstance(gid, str) and gid else (old.gramps_id if old else "")),
            version=int(item.get("version") or 0), seq=seq, deleted=not live,
            obj_json=item.get("obj_json") if live else None, op=op, at=item.get("at"),
            origin=item.get("origin"), principal=item.get("principal"), reason=item.get("reason"), hash=item.get("hash"),
        )

    def duplicate_ids(self) -> int:
        """How many (class, Gramps ID) pairs are held by more than one live head (catalog S13: the GID guard makes this impossible)."""

        seen: Dict[Tuple[str, str], int] = {}
        for head in self.live_heads():
            if head.gramps_id:
                seen[(head.cls, head.gramps_id)] = seen.get((head.cls, head.gramps_id), 0) + 1
        return sum(1 for n in seen.values() if n > 1)

    def live_heads(self) -> List[Head]:
        return [h for h in self.heads.values() if not h.deleted and h.obj_json is not None]

    def parsed_objects(self) -> Dict[Key, Dict[str, Any]]:
        """Every live object, parsed, with ``_class`` and ``handle`` guaranteed."""

        out: Dict[Key, Dict[str, Any]] = {}
        for head in self.live_heads():
            obj = json.loads(head.obj_json or "null")
            if not isinstance(obj, dict):
                continue
            obj.setdefault("_class", head.cls)
            obj.setdefault("handle", head.handle)
            out[head.key] = obj
        return out


def reverse_refs(objects: Dict[Key, Dict[str, Any]]) -> Dict[Key, Set[Key]]:
    """target key -> the live objects that reference it. A target that no longer exists keeps its referrers (a dangling reference)."""

    rev: Dict[Key, Set[Key]] = {}
    for src, obj in objects.items():
        for target in collect_refs(obj):
            rev.setdefault(target, set()).add(src)
    return rev


def people_of(
    subjects: Iterable[Key], objects: Dict[Key, Dict[str, Any]], rev: Dict[Key, Set[Key]], gid_of: Callable[[Key], str]
) -> Set[str]:
    """The Gramps ID of every live person whose page a change to any of ``subjects`` can alter (BRD2 11.1, the render outbox).

    A person subject maps to itself and to whatever references it (the families that list them, which show their names to the
    spouse and the children). Any other subject maps through its referrers until persons are reached. Persons are terminal, so a
    change never spreads from a person to the whole tree."""

    result: Set[str] = set()
    for start in subjects:
        seen: Set[Key] = {start}
        queue = deque([start])
        while queue:
            node = queue.popleft()
            if node[0] == "Person" and node in objects:
                gid = gid_of(node)
                if gid:
                    result.add(gid)
                if node != start:
                    continue  # a person reached from elsewhere is a result, not a hop
            for src in rev.get(node, ()):
                if src in seen:
                    continue
                seen.add(src)
                queue.append(src)
    return result


def closure_from(root_obj: Dict[str, Any], objects: Dict[Key, Dict[str, Any]]) -> Set[str]:
    """Handles reachable by references from ``root_obj`` without passing through another person (what a person's page was built from)."""

    out: Set[str] = set()
    queue = deque(collect_refs(root_obj))
    while queue:
        key = queue.popleft()
        if key[0] == "Person" or key[1] in out:
            continue  # other people are neither part of this person's page sources nor a hop to the rest of the tree
        out.add(key[1])
        obj = objects.get(key)
        if obj is not None:
            queue.extend(collect_refs(obj))
    return out
