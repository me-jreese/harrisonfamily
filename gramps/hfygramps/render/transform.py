"""The D-02-fixed ETL transforms, ported to run on an in-memory store view (HFY-TSK-229; parity with the live ETL).

Every function here is the live ETL's (``scripts/etl/transform.py`` and the helpers in ``export_person_data.py``) with
the same name, the same inputs and the same output bytes, except where this module says otherwise:

* ``Store`` replaces the SQLite repository; there is no file, SQLite, network or AWS access anywhere in this package.
* The io-approved allowlist is replaced by a text gate (``policy.default_text_gate``), see ``policy.py``.
* Sets are walked in sorted order, so a run does not depend on ``PYTHONHASHSEED``.
* Event order stays the legacy ordering key: ``(date.sortval, label)``, ties in input order. ``sortval`` orders events and
  is never published (HFY-ISS-025).
"""

from __future__ import annotations

import copy
from collections import Counter
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from . import labels
from .note_tags import normalise_note_text
from .policy import TextGate, default_text_gate, gated_text, is_private, public_items, public_urls, scrub_attributes
from .store import Store


def extract_handles(values: Iterable[Any], key: str = "ref") -> set:
    handles: set = set()
    for item in values:
        if isinstance(item, dict):
            value = item.get(key)
            if value:
                handles.add(value)
        elif isinstance(item, str):
            if item:
                handles.add(item)
    return handles


def derive_media_extension(source_path: str, mime: Optional[str]) -> str:
    ext = PurePosixPath(source_path).suffix.lower() if source_path else ""
    if ext:
        return ext
    mime_map = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/webp": ".webp",
    }
    if mime:
        candidate = mime_map.get(mime.lower())
        if candidate:
            return candidate
    return ".bin"


def format_display_name(primary_name: Dict[str, Any]) -> Dict[str, str]:
    first = primary_name.get("first_name", "").strip()
    surnames = primary_name.get("surname_list", [])
    surname = ""
    for part in surnames:
        if part.get("primary"):
            surname = part.get("surname", "").strip()
            break
    display = (first + " " + surname).strip() or "Unknown"
    return {"givenName": first, "surname": surname, "displayName": display}


def map_gender(code: Optional[int]) -> str:
    if code == 0:
        return "female"
    if code == 1:
        return "male"
    return "unspecified"


def summarize_years(birth_year: Optional[int], death_year: Optional[int]) -> str:
    if birth_year and death_year:
        return f"{birth_year}–{death_year}"
    if birth_year and not death_year:
        return f"{birth_year}–"
    if death_year and not birth_year:
        return f"–{death_year}"
    return ""


def build_place_summary(place: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not place:
        return None
    name_data = place.get("name", {}) or {}
    return {
        "handle": place.get("handle"),
        "grampsId": place.get("gramps_id"),
        "displayName": name_data.get("value") or place.get("title") or "Unknown place",
        "latitude": place.get("lat") or None,
        "longitude": place.get("long") or None,
    }


def build_place_payload(
    place: Dict[str, Any],
    place_lookup: Dict[str, Dict[str, Any]],
    gate: Optional[TextGate] = None,
) -> Dict[str, Any]:
    summary = build_place_summary(place) or {}
    place_type = place.get("place_type") or {}
    parents: List[Dict[str, Any]] = []
    for ref in place.get("placeref_list", []):
        if not isinstance(ref, dict):
            continue
        handle = ref.get("ref")
        if not handle:
            continue
        parent_obj = place_lookup.get(handle)
        parent_summary = build_place_summary(parent_obj) if parent_obj else None
        if parent_summary:
            parents.append(parent_summary)
        else:
            parents.append(
                {
                    "handle": handle,
                    "grampsId": None,
                    "displayName": "Unknown place",
                    "latitude": None,
                    "longitude": None,
                }
            )
    return {
        **summary,
        # D-02: {code, string} with the English PlaceType label (custom types use their own string).
        "type": labels.place_type(place_type),
        "code": place.get("code") or None,
        "parents": parents,
        # R-18 / Q2-02 item 2: a contact URL, or a URL whose path or description carries contact data, is dropped.
        "urls": public_urls(place.get("urls"), gate or default_text_gate),
    }


def coerce_event_type(event: Dict[str, Any]) -> Dict[str, Optional[Any]]:
    """`{string, code}` with the English EventType label; custom types use their own string (D-02)."""

    return labels.event_type(event.get("type"))


def _has_day_or_month(date: Dict[str, Any]) -> bool:
    dateval = date.get("dateval") or [0, 0, 0, False]
    return bool(dateval[0]) or bool(dateval[1])


def _event_sort_key(event: Dict[str, Any]) -> int:
    """The legacy ordering key: Gramps sortval, used only to order events and never published (HFY-ISS-025)."""

    return (event.get("date") or {}).get("sortval") or 0


def build_event_payload(
    event: Dict[str, Any],
    fallback_label: str,
    place_lookup: Dict[str, Dict[str, Any]],
    role: Optional[Any] = None,
    gate: Optional[TextGate] = None,
) -> Dict[str, Any]:
    date = event.get("date", {}) or {}
    place_handle = event.get("place")
    place_obj = place_lookup.get(place_handle) if place_handle else None
    place = build_place_summary(None if is_private(place_obj) else place_obj)
    event_type = coerce_event_type(event)
    label = event_type["string"] or fallback_label

    payload = {
        "handle": event["handle"],
        "grampsId": event.get("gramps_id"),
        "label": label,
        "type": event_type,
        # HFY-ISS-025 / R-19: no day-precise dates leave the renderer. Gramps sortval is the exact Julian day for a
        # full date, so it is never emitted (callers sort with _event_sort_key), and date.text is dropped whenever the
        # date carries a day or month. Only the year is published.
        "date": {
            "text": "" if _has_day_or_month(date) else date.get("text"),
            "year": date.get("dateval", [0, 0, 0, False])[2],
        },
        "place": place,
        # The description is free text: it passes the text gate like a note, and is `None` when it is blocked.
        "description": gated_text(event.get("description"), gate or default_text_gate),
    }
    if role is not None:
        payload["role"] = labels.event_role(role)
    return payload


def build_family_events(
    family: Dict[str, Any],
    event_lookup: Optional[Dict[str, Dict[str, Any]]],
    place_lookup: Optional[Dict[str, Dict[str, Any]]],
    gate: Optional[TextGate] = None,
) -> List[Dict[str, Any]]:
    """Family events with their role. Private EventRefs and private events are skipped (D-02, PS-06)."""

    if not event_lookup:
        return []
    places = place_lookup or {}
    ordered: List[Tuple[int, str, Dict[str, Any]]] = []
    for ref in public_items(family.get("event_ref_list")):
        if not isinstance(ref, dict):
            continue
        event = event_lookup.get(ref.get("ref"))
        if not event or is_private(event):
            continue
        payload = build_event_payload(event, "Event", places, role=ref.get("role"), gate=gate)
        ordered.append((_event_sort_key(event), payload["label"], payload))
    ordered.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in ordered]


def build_family_payload(
    family: Dict[str, Any],
    person_lookup: Dict[str, Dict[str, Any]],
    event_lookup: Optional[Dict[str, Dict[str, Any]]] = None,
    place_lookup: Optional[Dict[str, Dict[str, Any]]] = None,
    gate: Optional[TextGate] = None,
) -> Dict[str, Any]:
    def ref_payload(handle: Optional[str]) -> Optional[Dict[str, Any]]:
        if not handle:
            return None
        entry = person_lookup.get(handle, {})
        if entry.get("private"):
            # A private person is not published, and neither is their place in a family.
            return None
        if not entry:
            return {"handle": handle}
        stub = {
            "handle": handle,
            "grampsId": entry.get("grampsId"),
            "displayName": entry.get("displayName"),
            "isLiving": entry.get("isLiving"),
        }
        if "gender" in entry:
            stub["gender"] = entry.get("gender")
        if "lifespan" in entry:
            stub["lifespan"] = entry.get("lifespan")
        return stub

    children = []
    for child in public_items(family.get("child_ref_list")):
        handle = child.get("ref")
        if handle and person_lookup.get(handle, {}).get("private"):
            continue
        info = ref_payload(handle) or {"handle": handle}
        # D-02: relationship to each parent as {code, string} (Birth, Adopted, Foster, ...).
        info["frel"] = labels.child_ref_type(child.get("frel")) if child.get("frel") is not None else None
        info["mrel"] = labels.child_ref_type(child.get("mrel")) if child.get("mrel") is not None else None
        children.append(info)

    return {
        "handle": family["handle"],
        "grampsId": family.get("gramps_id"),
        "type": labels.family_type(family.get("type")),
        "father": ref_payload(family.get("father_handle")),
        "mother": ref_payload(family.get("mother_handle")),
        "children": children,
        "events": build_family_events(family, event_lookup, place_lookup, gate),
    }


def gather_person_bundle(repo: Store, person_handle: str) -> Dict[str, Any]:
    """Collect everything a person's JSON can reference.

    D-02 / PS-06: private objects and private secondary elements (EventRef, ChildRef, MediaRef) are never followed, so
    an event, note or media object that is reachable only through something private is not collected either (the
    object-level form of "private by association", BRD2 5.1b). Handles withheld because the object itself is private
    are recorded in `private_handles` so the transform can skip them rather than emit a `missing` stub.
    """

    person = repo.fetch("person", person_handle)
    if not person:
        raise ValueError(f"Person handle not found: {person_handle}")

    person_id = person.get("gramps_id")

    event_handles = extract_handles(public_items(person.get("event_ref_list", [])))
    media_handles = extract_handles(public_items(person.get("media_list", [])))
    note_handles = set(person.get("note_list", []))
    family_handles = set(person.get("family_list", [])) | set(person.get("parent_family_list", []))
    place_handles: set = set()

    events: Dict[str, Dict[str, Any]] = {}
    families: Dict[str, Dict[str, Any]] = {}
    media: Dict[str, Dict[str, Any]] = {}
    notes: Dict[str, Dict[str, Any]] = {}
    places: Dict[str, Dict[str, Any]] = {}
    private_handles: set = set()

    processed_events: set = set()
    processed_families: set = set()
    processed_media: set = set()
    processed_notes: set = set()

    # Families
    while family_handles - processed_families:
        handle = sorted(family_handles - processed_families)[0]
        processed_families.add(handle)
        family = repo.fetch("family", handle)
        if not family:
            continue
        if is_private(family):
            private_handles.add(handle)
            continue
        families[handle] = family
        family_event_handles = extract_handles(public_items(family.get("event_ref_list", [])))
        event_handles.update(family_event_handles)
        note_handles.update(family.get("note_list", []))
        media_handles.update(extract_handles(public_items(family.get("media_list", []))))

    # Events
    while event_handles - processed_events:
        handle = sorted(event_handles - processed_events)[0]
        processed_events.add(handle)
        event = repo.fetch("event", handle)
        if not event:
            continue
        if is_private(event):
            private_handles.add(handle)
            continue
        events[handle] = event
        note_handles.update(event.get("note_list", []))
        media_handles.update(extract_handles(public_items(event.get("media_list", []))))
        place_handle = event.get("place")
        if isinstance(place_handle, str) and place_handle:
            place_handles.add(place_handle)

    # Places
    while place_handles:
        handle = sorted(place_handles)[0]
        place_handles.discard(handle)
        if handle in places or handle in private_handles:
            continue
        place = repo.fetch("place", handle)
        if not place:
            continue
        if is_private(place):
            private_handles.add(handle)
            continue
        places[handle] = place
        parent_refs = extract_handles(public_items(place.get("placeref_list", [])))
        place_handles.update(parent_refs - places.keys() - private_handles)

    # Media
    while media_handles - processed_media:
        handle = sorted(media_handles - processed_media)[0]
        processed_media.add(handle)
        media_obj = repo.fetch("media", handle)
        if not media_obj:
            continue
        if is_private(media_obj):
            private_handles.add(handle)
            continue
        media[handle] = media_obj
        note_handles.update(media_obj.get("note_list", []))

    # Notes
    while note_handles - processed_notes:
        handle = sorted(note_handles - processed_notes)[0]
        processed_notes.add(handle)
        note_obj = repo.fetch("note", handle)
        if not note_obj:
            continue
        if is_private(note_obj):
            private_handles.add(handle)
            continue
        notes[handle] = note_obj

    return {
        "person": person,
        "events": events,
        "families": families,
        "media": media,
        "notes": notes,
        "places": places,
        "person_id": person_id,
        "private_handles": private_handles,
    }


def published_notes(
    notes: Dict[str, Dict[str, Any]],
    gate: TextGate,
) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, str]]:
    """Split notes into the published ones and the withheld ones `{handle: reason}` (reason `blocked`: the text gate).

    Reasons are for logs and counts; no text is ever included.
    """

    approved: Dict[str, Dict[str, Any]] = {}
    withheld: Dict[str, str] = {}
    for handle, note in notes.items():
        if gate(_note_string(note)):
            approved[handle] = note
        else:
            withheld[handle] = "blocked"
    return approved, withheld


def _note_string(note: Dict[str, Any]) -> str:
    text = note.get("text") or {}
    string = text.get("string") if isinstance(text, dict) else None
    if string is None and isinstance(text, dict):
        string = text.get("_string")
    return string if isinstance(string, str) else ""


def note_payload(note: Dict[str, Any], gate: Optional[TextGate] = None) -> Dict[str, Any]:
    return {
        "handle": note["handle"],
        "grampsId": note.get("gramps_id"),
        **normalise_note_text(note, gate or default_text_gate),
    }


# ---------------------------------------------------------------------------------------------------------
# Photo regions and tags (D-02, R-29, R-30, R-31)
# ---------------------------------------------------------------------------------------------------------

TAG_SOURCE = "gramps"


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def mediaref_rect(raw: Any) -> Optional[List[int]]:
    """A MediaRef rect exactly as Gramps stores it (`[x1, y1, x2, y2]`, integer percent), or None.

    None means "tagged without an area marked": a missing (`null`) or empty rect, and `[0, 0, 0, 0]`, Gramps' own
    "no region". Any other four integers are copied exactly: corners are NOT ordered, clamped or validated here,
    because consumers apply the crop rule. A malformed value (not four integers) is also None.
    """

    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    if not all(_is_int(v) for v in raw):
        return None
    if all(v == 0 for v in raw):
        return None
    return [int(v) for v in raw]


def rect_is_malformed(raw: Any) -> bool:
    """True for a stored rect that is neither "no region" (null, empty, all zero) nor four integers."""

    if raw is None or (isinstance(raw, (list, tuple)) and len(raw) == 0):
        return False
    if isinstance(raw, (list, tuple)) and len(raw) == 4 and all(_is_int(v) for v in raw):
        return False
    return True


@dataclass
class MediaTags:
    """Every published person tag on every media object, collected once per run over the whole tree.

    A tag is a public MediaRef in a public person's `media_list` that points at a public media object (so a group photo
    lists everyone tagged in it, in every tagged person's gallery). Private persons, private MediaRefs, private media,
    private attributes, private notes, private citations and private sources are skipped. AGE, FATHER_AGE, MOTHER_AGE,
    TIME, SSN and ID attribute values are dropped (`scrub_attributes`). Citations publish as their source titles only.
    Region notes, attribute values and citation titles also pass the text gate.
    """

    by_media: Dict[str, List[Dict[str, Any]]] = field(default_factory=dict)
    # Published region notes (handle -> Gramps note) and withheld ones (handle -> reason; no text).
    region_notes: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    withheld_region_notes: Dict[str, str] = field(default_factory=dict)
    counts: Counter = field(default_factory=Counter)
    gate: Optional[TextGate] = None

    def _notes(self, record: Dict[str, Any]) -> List[Dict[str, Any]]:
        return [note_payload(self.region_notes[h], self.gate) for h in record["noteHandles"] if h in self.region_notes]

    def tags_for(self, media_handle: str) -> List[Dict[str, Any]]:
        """`mediaGallery[].tags[]`: `{grampsId, name, rect, isPrimary, attributes, notes, citations, source}`."""

        return [
            {
                "grampsId": record["grampsId"],
                "name": record["name"],
                "rect": copy.deepcopy(record["rect"]),
                "isPrimary": record["isPrimary"],
                "attributes": copy.deepcopy(record["attributes"]),
                "notes": self._notes(record),
                "citations": list(record["citations"]),
                "source": TAG_SOURCE,
            }
            for record in self.by_media.get(media_handle, [])
        ]

    def regions_for(self, media_handle: str) -> List[Dict[str, Any]]:
        """`media/<handle>.json` `regions[]`: `{person: {handle, grampsId, displayName}, rect, attributes, notes}`."""

        return [
            {
                "person": {
                    "handle": record["personHandle"],
                    "grampsId": record["grampsId"],
                    "displayName": record["name"],
                },
                "rect": copy.deepcopy(record["rect"]),
                "attributes": copy.deepcopy(record["attributes"]),
                "notes": self._notes(record),
            }
            for record in self.by_media.get(media_handle, [])
        ]

    def notes_for_media(self, media_handles: Iterable[str]) -> Dict[str, Dict[str, Any]]:
        """Published region notes on the tags of these media: the writer puts them in note/."""

        notes: Dict[str, Dict[str, Any]] = {}
        for media_handle in media_handles:
            for record in self.by_media.get(media_handle, []):
                for handle in record["noteHandles"]:
                    if handle in self.region_notes:
                        notes[handle] = self.region_notes[handle]
        return notes


def _mediaref_attributes(mref: Dict[str, Any], gate: TextGate, counts: Counter) -> List[Dict[str, Any]]:
    """Published `{type, value}` for one MediaRef. Private attributes and the sensitive types are dropped first."""

    raw = mref.get("attribute_list") or []
    kept = {id(attribute) for attribute in scrub_attributes(raw)}
    published: List[Dict[str, Any]] = []
    for attribute in raw:
        if not isinstance(attribute, dict):
            continue
        if id(attribute) not in kept:
            counts["attribute_dropped"] += 1
            continue
        value = attribute.get("value")
        text = value if isinstance(value, str) else ("" if value is None else str(value))
        if gate(text):
            counts["attribute_approved"] += 1
            published.append({"type": labels.attribute_type(attribute.get("type")).get("string"), "value": text})
        else:
            counts["attribute_blocked"] += 1
    return published


def _decide_region_note(
    handle: Any,
    fetch: Callable[[str, Any], Optional[Dict[str, Any]]],
    gate: TextGate,
    tags: MediaTags,
) -> Optional[str]:
    """The handle when this region note is published, else None (the reason is kept for the counts)."""

    if not isinstance(handle, str) or not handle:
        return None
    if handle in tags.region_notes:
        return handle
    if handle in tags.withheld_region_notes:
        return None
    note = fetch("note", handle)
    if not note:
        return None
    if is_private(note):
        tags.withheld_region_notes[handle] = "private"
        return None
    if not gate(_note_string(note)):
        tags.withheld_region_notes[handle] = "blocked"
        return None
    tags.region_notes[handle] = note
    return handle


def _citation_titles(
    handles: Iterable[Any],
    fetch: Callable[[str, Any], Optional[Dict[str, Any]]],
    gate: TextGate,
    counts: Counter,
) -> List[str]:
    """Source titles of the public citations (titles only: no page, date or confidence), de-duplicated in order."""

    titles: List[str] = []
    for handle in handles or []:
        citation = fetch("citation", handle)
        if not citation or is_private(citation):
            continue
        source = fetch("source", citation.get("source_handle"))
        if not source or is_private(source):
            continue
        title = source.get("title")
        if not isinstance(title, str) or not title.strip():
            continue
        title = title.strip()
        if not gate(title):
            counts["citation_title_blocked"] += 1
            continue
        if title not in titles:
            titles.append(title)
    counts["citation_title"] += len(titles)
    return titles


def collect_media_tags(repo: Store, gate: TextGate) -> MediaTags:
    """Scan every person once and index their public MediaRefs by media handle (see `MediaTags`)."""

    tags = MediaTags(gate=gate)

    def fetch(table: str, handle: Any) -> Optional[Dict[str, Any]]:
        return repo.fetch(table, handle)

    for person_handle, _gramps_id in repo.iter_person_handles():
        person = repo.fetch("person", person_handle)
        if not person or is_private(person) or not person.get("primary_name"):
            continue  # private persons are never tagged; a nameless person is not exported either
        gramps_id = person.get("gramps_id")
        gid = (gramps_id.strip() if isinstance(gramps_id, str) else gramps_id) or person_handle
        name = format_display_name(person["primary_name"])["displayName"]
        for ref_index, mref in enumerate(person.get("media_list") or []):
            if not isinstance(mref, dict):
                continue
            if is_private(mref):
                tags.counts["private_mediaref"] += 1
                continue
            media_handle = mref.get("ref")
            media = fetch("media", media_handle)
            if not media or is_private(media):
                continue
            note_handles: List[str] = []
            for note_handle in mref.get("note_list") or []:
                approved = _decide_region_note(note_handle, fetch, gate, tags)
                if approved and approved not in note_handles:
                    note_handles.append(approved)
            rect = mediaref_rect(mref.get("rect"))
            if rect_is_malformed(mref.get("rect")):
                tags.counts["rect_malformed"] += 1
            tags.by_media.setdefault(media_handle, []).append(
                {
                    "personHandle": person_handle,
                    "grampsId": gid,
                    "name": name,
                    "rect": rect,
                    # Index 0 of the person's media_list is their portrait (the graph builder's face source).
                    "isPrimary": ref_index == 0,
                    "refIndex": ref_index,
                    "attributes": _mediaref_attributes(mref, gate, tags.counts),
                    "noteHandles": note_handles,
                    "citations": _citation_titles(mref.get("citation_list") or [], fetch, gate, tags.counts),
                }
            )
            tags.counts["tags"] += 1
            if rect is not None:
                tags.counts["tags_with_rect"] += 1

    for records in tags.by_media.values():
        records.sort(key=lambda r: (str(r["grampsId"]), r["personHandle"], r["refIndex"]))
    return tags


def transform_person(
    bundle: Dict[str, Any],
    person_lookup: Dict[str, Dict[str, Any]],
    gate: TextGate,
    media_tags: Optional[MediaTags] = None,
    media_ext: Optional[Dict[str, str]] = None,
) -> Tuple[Dict[str, Any], Dict[str, Dict[str, Any]]]:
    """The person JSON and the resources it references.

    Pass `media_tags` (one `collect_media_tags` per run) for `mediaGallery[].tags`; without it every `tags` is empty.
    `media_ext` maps a media handle to the file extension of its stored blob (the store view blanks `Media.path`).
    """

    person = bundle["person"]
    events = bundle["events"]
    families = bundle["families"]
    media = bundle["media"]
    places = bundle["places"]
    person_id = bundle["person_id"]
    private_handles = bundle.get("private_handles") or set()
    notes, withheld_notes = published_notes(bundle["notes"], gate)

    name_parts = format_display_name(person["primary_name"])
    gender = map_gender(person.get("gender"))

    event_refs = person.get("event_ref_list", [])
    birth_index = person.get("birth_ref_index", -1)
    death_index = person.get("death_ref_index", -1)

    def event_label(idx: int) -> str:
        if idx == birth_index:
            return "Birth"
        if idx == death_index:
            return "Death"
        return "Event"

    event_payloads: List[Dict[str, Any]] = []
    sort_keys: Dict[int, int] = {}
    payload_by_index: Dict[int, Dict[str, Any]] = {}
    for idx, ref in enumerate(event_refs):
        if is_private(ref):
            continue
        handle = ref.get("ref")
        event = events.get(handle)
        if not event:
            continue
        # D-02: the label is the event's own type label (Birth, Death, Marriage, Residence, a custom type's string); the
        # index-based Birth/Death/Event label is only the fallback for a typeless event.
        label = event_label(idx)
        payload = build_event_payload(event, label, places, gate=gate)
        sort_keys[id(payload)] = _event_sort_key(event)
        payload_by_index[idx] = payload
        event_payloads.append(payload)

    event_payloads.sort(key=lambda e: (sort_keys[id(e)], e["label"]))

    birth_details = payload_by_index.get(birth_index)
    death_details = payload_by_index.get(death_index)

    birth_year = birth_details["date"]["year"] if birth_details else None
    death_year = death_details["date"]["year"] if death_details else None

    # D-02 / R-29 / R-30: each gallery item carries this person's own region on it (`region`, the exact integer rect or
    # null) and every published person tag on that media (`tags`, from `collect_media_tags`).
    media_entries = [
        entry for entry in public_items(person.get("media_list", [])) if isinstance(entry, dict) and entry.get("ref")
    ]
    media_payloads = []
    for entry in media_entries:
        ref = entry["ref"]
        region = mediaref_rect(entry.get("rect"))
        media_obj = media.get(ref)
        if not media_obj and ref in private_handles:
            continue
        if not media_obj:
            media_payloads.append(
                {
                    "handle": ref,
                    "title": None,
                    "missing": True,
                    "region": region,
                    "tags": [],
                }
            )
            continue
        payload = {
            "handle": media_obj["handle"],
            "grampsId": media_obj.get("gramps_id"),
            "title": media_title(media_obj, gate),
            "mime": media_obj.get("mime"),
            # D-02 / R-19: neither the local path (`sourcePath`) nor a third-party placeholder URL is published.
            "s3Key": media_s3_key(media_obj, (media_ext or {}).get(media_obj["handle"])),
            "region": region,
            "tags": media_tags.tags_for(ref) if media_tags is not None else [],
        }
        media_payloads.append(payload)

    primary_photo = media_payloads[0] if media_payloads else None

    note_payloads = []
    for ref in person.get("note_list", []):
        note_obj = notes.get(ref)
        if not note_obj:
            continue
        note_payloads.append(note_payload(note_obj, gate))

    parent_family_handles = person.get("parent_family_list", [])
    family_handles = person.get("family_list", [])

    parent_families = [
        build_family_payload(families[handle], person_lookup, events, places)
        for handle in parent_family_handles
        if handle in families
    ]
    spouse_families = [
        build_family_payload(families[handle], person_lookup, events, places)
        for handle in family_handles
        if handle in families
    ]

    lifespan = {
        "birth": {
            "year": birth_year,
            "place": birth_details.get("place") if birth_details else None,
        },
        "death": {
            "year": death_year,
            "place": death_details.get("place") if death_details else None,
        },
        "summary": summarize_years(birth_year, death_year),
    }

    # SYNC-15 / D2-08: the legacy living rule, kept for parity until the privacy plan changes it.
    is_living = person.get("death_ref_index", -1) == -1

    payload = {
        "grampsId": person_id,
        "handle": person.get("handle"),
        **name_parts,
        "gender": gender,
        "isLiving": is_living,
        "lifespan": lifespan,
        "primaryPhoto": primary_photo,
        "mediaGallery": media_payloads,
        "notes": note_payloads,
        "familyTree": {
            "parentFamilies": parent_families,
            "spouseFamilies": spouse_families,
        },
        "events": event_payloads,
    }

    resources = {
        "events": events,
        "families": families,
        "media": media,
        "notes": notes,
        "places": places,
        "withheld_notes": withheld_notes,
    }

    return payload, resources


def media_title(media_obj: Dict[str, Any], gate: Optional[TextGate] = None) -> Optional[str]:
    """``Media.desc`` when it passes the text gate, else the Gramps ID (the title never carries blocked free text)."""

    return gated_text(media_obj.get("desc"), gate or default_text_gate) or media_obj.get("gramps_id")


def media_s3_key(media_obj: Dict[str, Any], ext: Optional[str] = None) -> str:
    """`media/<handle><ext>`: the extension comes from the caller, else from the Media path, else from its mime type."""

    suffix = ext if ext else derive_media_extension(media_obj.get("path", ""), media_obj.get("mime"))
    return f"media/{media_obj['handle']}{suffix}"
