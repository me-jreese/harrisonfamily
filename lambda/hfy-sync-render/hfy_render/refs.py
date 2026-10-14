"""Handle references of a Gramps-6 JSON object: the Python twin of ``collectRefs`` in ``api/src/records/semantics.js``.

The renderer uses it to map a change in any object to the people whose pages it can alter (the render outbox's
``changed_people``). ``test_render_lambda_view`` runs both on the same objects and requires the same references.
"""

from __future__ import annotations

from typing import Any, Iterator, List, Tuple

STRING_LIST_CLASS = {"note_list": "Note", "citation_list": "Citation", "tag_list": "Tag", "family_list": "Family", "parent_family_list": "Family"}
SCALAR_CLASS = {"father_handle": "Person", "mother_handle": "Person", "source_handle": "Source", "place": "Place"}
ELEMENT_LIST_CLASS = {
    "event_ref_list": "Event", "child_ref_list": "Person", "media_list": "Media", "person_ref_list": "Person",
    "placeref_list": "Place", "reporef_list": "Repository",
}


def collect_refs(obj: Any) -> List[Tuple[str, str]]:
    """Every ``(class, handle)`` an object holds, in document order."""

    out: List[Tuple[str, str]] = []

    def walk(value: Any, field: Any) -> None:
        if isinstance(value, list):
            str_cls = STRING_LIST_CLASS.get(field) if field is not None else None
            el_cls = ELEMENT_LIST_CLASS.get(field) if field is not None else None
            for item in value:
                if str_cls:
                    if isinstance(item, str) and item:
                        out.append((str_cls, item))
                else:
                    if el_cls and isinstance(item, dict) and isinstance(item.get("ref"), str) and item["ref"]:
                        out.append((el_cls, item["ref"]))
                    walk(item, None)
        elif isinstance(value, dict):
            for key in value:
                child = value[key]
                if key in SCALAR_CLASS and isinstance(child, str):
                    if child:
                        out.append((SCALAR_CLASS[key], child))
                else:
                    walk(child, key)

    walk(obj, None)
    return out


def iter_refs(obj: Any) -> Iterator[Tuple[str, str]]:
    yield from collect_refs(obj)
