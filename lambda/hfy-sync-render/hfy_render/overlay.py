"""The ``MOD#`` overlay (HFY-TSK-216, hfy-moderation-record-targets; BRD2 D2-19, D2-34, review DL-15, PS-07): what a moderator hid, removed before the render.

An open, hidden ``MOD#note:<handle>``, ``MOD#mediaref:<holder handle>:<media handle>`` or ``MOD#media:<handle>`` item (written by ``POST /api/moderation``,
``api/src/moderation.js``) takes the note, the MediaRef or the Media out of every rendered key at once, because the render only ever sees the objects this
overlay returns: the person, family, event, place, source, citation, note and media JSON, ``media/index.json`` and ``person/search-index.json``. It is the
Python twin of ``api/src/records/mod-overlay.js`` (the records API, the edit bundle and MCP use that one); the two read the same items the same way.

The open items come from GSI1 (``MODQ#open``), which is eventually consistent. The moderation marker (``origin`` moderation, ``marker.ref`` the Note, the Media or
the Person holding the MediaRef) wakes this pass at once, so the overlay also reads the items that markers of this pass's range name with a consistent read, and
that read wins over the index: a hide the index has not caught up with is never missed, and an unhide is seen as soon as it is written. A failed read raises
``RenderFailed(overlay.unreadable)``: the pass does not advance, and nothing is rendered from an overlay that could not be read (fail closed).

``apply(objects, hints)`` returns ``(objects, exempt_delete_keys)``: the objects without the hidden ones and without the references to them, and the site keys of
the hidden Note and Media files, whose deletion is exposure-reducing and so exempt from the mass-delete guard.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from . import errors

NOTE, MEDIA, MEDIAREF = "note", "media", "mediaref"


def _parse(target: str) -> Optional[Tuple[str, str, Optional[str]]]:
    """``note:<h>`` -> (note, h, None); ``media:<h>`` -> (media, h, None); ``mediaref:<holder>:<media>`` -> (mediaref, holder, media)."""

    kind, _, rest = target.partition(":")
    if not rest:
        return None
    if kind in (NOTE, MEDIA):
        return (kind, rest, None) if ":" not in rest else None
    if kind == MEDIAREF:
        holder, _, media = rest.partition(":")
        return (kind, holder, media) if holder and media and ":" not in media else None
    return None


def _hides(item: Optional[Dict[str, Any]]) -> bool:
    return isinstance(item, dict) and item.get("entity") == "mod" and item.get("hidden") is True and item.get("open") is not False


class Hidden:
    """The three sets an overlay applies."""

    def __init__(self) -> None:
        self.notes: Set[str] = set()
        self.media: Set[str] = set()
        self.refs: Set[Tuple[str, str]] = set()

    def add(self, target: str) -> None:
        parsed = _parse(target)
        if parsed is None:
            return
        kind, a, b = parsed
        if kind == NOTE:
            self.notes.add(a)
        elif kind == MEDIA:
            self.media.add(a)
        else:
            self.refs.add((a, b or ""))

    def discard(self, target: str) -> None:
        parsed = _parse(target)
        if parsed is None:
            return
        kind, a, b = parsed
        if kind == NOTE:
            self.notes.discard(a)
        elif kind == MEDIA:
            self.media.discard(a)
        else:
            self.refs.discard((a, b or ""))

    def __bool__(self) -> bool:
        return bool(self.notes or self.media or self.refs)


def _strip(value: Any, hidden: Hidden, holder: Optional[str]) -> Any:
    """A copy of ``value`` without the hidden note handles of any ``note_list`` and the hidden MediaRefs of any ``media_list`` (the holder is the top object)."""

    if isinstance(value, list):
        return [_strip(v, hidden, holder) for v in value]
    if not isinstance(value, dict):
        return value
    out: Dict[str, Any] = {}
    for k, v in value.items():
        if k == "note_list" and isinstance(v, list):
            out[k] = [h for h in v if not (isinstance(h, str) and h in hidden.notes)]
        elif k == "media_list" and isinstance(v, list):
            out[k] = [
                _strip(r, hidden, holder) for r in v
                if not (isinstance(r, dict) and isinstance(r.get("ref"), str) and (r["ref"] in hidden.media or (holder, r["ref"]) in hidden.refs))
            ]
        else:
            out[k] = _strip(v, hidden, holder)
    return out


class ModOverlay:
    """``Deps.overlay`` for the engine: reads the open ``MOD#`` items from the table (``query_open_mods`` and a consistent ``get``)."""

    def __init__(self, table: Any) -> None:
        self.table = table

    def load(self, objects: Iterable[Dict[str, Any]], hints: Iterable[Tuple[str, str]] = ()) -> Hidden:
        hidden = Hidden()
        try:
            for item in self.table.query_open_mods():
                pk = item.get("PK") if isinstance(item, dict) else None
                if isinstance(pk, str) and pk.startswith("MOD#") and _hides(item):
                    hidden.add(pk[len("MOD#"):])
            # The consistent read of what this pass's moderation markers name wins over the index.
            by_handle = {(o.get("_class"), o.get("handle")): o for o in objects}
            for target in self._candidates(hints, by_handle):
                item = self.table.get(f"MOD#{target}", "META", True)
                if _hides(item):
                    hidden.add(target)
                else:
                    hidden.discard(target)
        except errors.RenderFailed:
            raise
        except Exception as exc:  # noqa: BLE001
            raise errors.RenderFailed(errors.RULE_OVERLAY, type(exc).__name__) from None
        return hidden

    @staticmethod
    def _candidates(hints: Iterable[Tuple[str, str]], by_handle: Dict[Tuple[Any, Any], Dict[str, Any]]) -> List[str]:
        out: List[str] = []
        for cls, handle in dict.fromkeys(hints):
            if cls == "Note":
                out.append(f"{NOTE}:{handle}")
            elif cls == "Media":
                out.append(f"{MEDIA}:{handle}")
            elif cls == "Person":
                person = by_handle.get(("Person", handle))
                for ref in (person or {}).get("media_list") or []:
                    if isinstance(ref, dict) and isinstance(ref.get("ref"), str):
                        out.append(f"{MEDIAREF}:{handle}:{ref['ref']}")
        return out

    def apply(self, objects: List[Dict[str, Any]], hints: Iterable[Tuple[str, str]] = ()) -> Tuple[List[Dict[str, Any]], Set[str]]:
        hidden = self.load(objects, hints)
        if not hidden:
            return objects, set()
        kept: List[Dict[str, Any]] = []
        exempt: Set[str] = set()
        # A hidden MediaRef can leave its Media unreferenced, and the site renders a media file only for a referenced Media: that file goes too, which is
        # exposure-reducing and so exempt from the guard (a delete of a file that stays is never planned, so naming it here is harmless).
        exempt.update(f"media/{media}.json" for _holder, media in hidden.refs)
        for obj in objects:
            cls, handle = obj.get("_class"), obj.get("handle")
            if cls == "Note" and handle in hidden.notes:
                exempt.add(f"note/{handle}.json")
            elif cls == "Media" and handle in hidden.media:
                exempt.add(f"media/{handle}.json")
            else:
                kept.append(_strip(obj, hidden, handle))
        return kept, exempt
