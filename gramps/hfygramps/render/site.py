"""``render_site(objects) -> {s3_key: bytes}``: the whole rendered data site from one store view (HFY-TSK-229).

The port of the live ETL's export (``export_person_data.main``) and of ``build_search_index.js``, with the D-02 fixes the
live ETL already carries. It is a pure function: no file, SQLite, network or AWS access (a test patches ``open`` and
``socket`` to prove it), no clock and no randomness. The same objects always give the same bytes.

Keys: ``person/<gramps_id>.json``, ``person/index.json``, ``person/search-index.json``, ``family/<handle>.json``,
``event/<handle>.json``, ``note/<handle>.json``, ``place/<handle>.json``, ``place/index.json``, ``media/<handle>.json``
and ``media/index.json``. Media binaries, ``person/index.html``, ``person/graph.json``, ``media/faces/*`` and the tree
SVGs are not rendered here and are never touched by a renderer built on this.
"""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional

from . import search_index
from .policy import TextGate, default_text_gate, is_private
from .store import Objects, Store
from .transform import (
    build_event_payload,
    build_family_payload,
    build_place_payload,
    collect_media_tags,
    format_display_name,
    gather_person_bundle,
    map_gender,
    media_s3_key,
    note_payload,
    summarize_years,
    transform_person,
)

#: Used when the caller gives no ``generated_at``. The render lambda passes the ``at`` of the head change (sync.md 11.1).
DEFAULT_GENERATED_AT = "1970-01-01T00:00:00.000Z"

MediaFiles = Mapping[str, Optional[Mapping[str, Any]]]


@dataclass
class RenderReport:
    """Counts only (no text, no handles): what was written and what was withheld."""

    files: Dict[str, int] = field(default_factory=dict)
    persons_skipped_private: int = 0
    persons_skipped_no_id: int = 0
    notes_published: int = 0
    notes_withheld: int = 0
    region_notes_published: int = 0
    region_notes_withheld: int = 0
    excluded_places: int = 0
    tag_counts: Dict[str, int] = field(default_factory=dict)


@dataclass
class RenderResult:
    files: Dict[str, bytes]
    report: RenderReport


def dumps(payload: Any) -> bytes:
    """The live ETL's file format: ``json.dumps(payload, indent=2, sort_keys=True)``, no trailing newline, UTF-8."""

    return json.dumps(payload, indent=2, sort_keys=True).encode("utf-8")


def extract_event_year(event: Optional[Dict[str, Any]]) -> Optional[int]:
    if not event:
        return None
    date = event.get("date", {}) or {}
    dateval = date.get("dateval")
    if isinstance(dateval, (list, tuple)) and len(dateval) >= 3:
        year = dateval[2]
        if isinstance(year, int) and year != 0:
            return year
    year_field = date.get("year")
    if isinstance(year_field, int) and year_field != 0:
        return year_field
    return None


def resolve_year_from_index(store: Store, event_refs: List[Dict[str, Any]], index: int) -> Optional[int]:
    if not isinstance(index, int) or index < 0:
        return None
    if index >= len(event_refs):
        return None
    handle = event_refs[index].get("ref")
    if not isinstance(handle, str) or not handle:
        return None
    return extract_event_year(store.fetch("event", handle))


def build_lifespan_stub(store: Store, person: Dict[str, Any]) -> Dict[str, Any]:
    event_refs = person.get("event_ref_list", []) or []
    birth_year = resolve_year_from_index(store, event_refs, person.get("birth_ref_index", -1))
    death_year = resolve_year_from_index(store, event_refs, person.get("death_ref_index", -1))
    return {
        "birth": {"year": birth_year},
        "death": {"year": death_year},
        "summary": summarize_years(birth_year, death_year),
    }


def build_lookup_entry(store: Store, person: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if is_private(person):
        # D-02 / PS-06: a private person is not exported and is dropped from every family reference.
        return {"private": True}
    primary = person.get("primary_name")
    if not primary:
        return None
    gramps_id = person.get("gramps_id")
    gid = gramps_id.strip() if isinstance(gramps_id, str) else gramps_id
    if not gid:
        gid = person.get("handle")
    name_parts = format_display_name(primary)
    return {
        "grampsId": gid,
        "displayName": name_parts["displayName"],
        "isLiving": person.get("death_ref_index", -1) == -1,
        "gender": map_gender(person.get("gender")),
        "lifespan": build_lifespan_stub(store, person),
    }


def _manifest_order(entry: Mapping[str, Any]) -> tuple:
    return (str(entry.get("grampsId") or ""), str(entry.get("handle") or ""))


def render(
    objects: Objects,
    *,
    media_files: Optional[MediaFiles] = None,
    generated_at: str = DEFAULT_GENERATED_AT,
    text_gate: Optional[TextGate] = None,
) -> RenderResult:
    gate = text_gate if text_gate is not None else default_text_gate
    store = Store(objects)
    report = RenderReport(excluded_places=len(store.excluded_places))
    files: Dict[str, bytes] = {}
    files_info = media_files or {}
    media_ext = {
        handle: info["ext"] for handle, info in files_info.items() if isinstance(info, Mapping) and info.get("ext")
    }

    media_tags = collect_media_tags(store, gate)

    # build_person_lookup: every person with a name; a person without a Gramps ID is rendered nowhere (no file, no index).
    person_lookup: Dict[str, Dict[str, Any]] = {}
    id_to_handle: Dict[str, str] = {}
    for handle, gramps_id in store.iter_person_handles():
        person = store.fetch("person", handle)
        if not person:
            continue
        if not gramps_id:
            report.persons_skipped_no_id += 1
            continue
        entry = build_lookup_entry(store, person)
        if not entry:
            continue
        person_lookup[handle] = entry
        id_to_handle.setdefault(gramps_id, handle)  # two heads with one ID: the first handle renders (S13)

    resource_cache: Dict[str, Dict[str, Any]] = {
        "events": {}, "families": {}, "media": {}, "notes": {}, "places": {}, "withheld_notes": {},
    }
    person_payloads: Dict[str, Dict[str, Any]] = {}

    for gramps_id in sorted(id_to_handle):
        person_handle = id_to_handle[gramps_id]
        if person_lookup.get(person_handle, {}).get("private"):
            report.persons_skipped_private += 1
            continue
        bundle = gather_person_bundle(store, person_handle)
        payload, resources = transform_person(bundle, person_lookup, gate, media_tags, media_ext)
        person_payloads[gramps_id] = payload
        for key in resource_cache:
            resource_cache[key].update(resources[key])

    # Supporting entities.
    for handle, event in resource_cache["events"].items():
        files[f"event/{handle}.json"] = dumps(build_event_payload(event, "Event", resource_cache["places"]))

    for handle, note in resource_cache["notes"].items():
        files[f"note/{handle}.json"] = dumps(note_payload(note))
    report.notes_published = len(resource_cache["notes"])
    report.notes_withheld = len(resource_cache["withheld_notes"])

    # Region notes: the published notes on the published tags of the media written in this run. They are inline in
    # tags[] and regions[], and written to note/ like person notes.
    region_notes = media_tags.notes_for_media(resource_cache["media"])
    for handle, note in region_notes.items():
        files[f"note/{handle}.json"] = dumps(note_payload(note))
    report.region_notes_published = len(region_notes)
    report.region_notes_withheld = len(media_tags.withheld_region_notes)
    report.tag_counts = dict(media_tags.counts)

    for handle, family in resource_cache["families"].items():
        payload = build_family_payload(family, person_lookup, resource_cache["events"], resource_cache["places"])
        files[f"family/{handle}.json"] = dumps(payload)

    place_manifest: List[Dict[str, Any]] = []
    for handle, place in resource_cache["places"].items():
        payload = build_place_payload(place, resource_cache["places"])
        files[f"place/{handle}.json"] = dumps(payload)
        place_manifest.append(
            {"handle": payload.get("handle"), "grampsId": payload.get("grampsId"), "displayName": payload.get("displayName")}
        )

    media_manifest: List[Dict[str, Any]] = []
    media_properties: Dict[str, Dict[str, Any]] = {}
    for handle, media in resource_cache["media"].items():
        info = files_info.get(handle)
        s3_key = media_s3_key(media, media_ext.get(handle))
        payload = {
            "handle": media["handle"],
            "grampsId": media.get("gramps_id"),
            "title": media.get("desc") or media.get("gramps_id"),
            "mime": media.get("mime"),
            # D-02 / R-19: no `sourcePath` (local path) and no third-party `placeholderImage`.
            "s3Key": s3_key,
            # R-29 / R-31: {person: {handle, grampsId, displayName}, rect, attributes, notes} per published tag.
            "regions": media_tags.regions_for(handle),
        }
        if info is None:
            payload["missing"] = True
            payload["checksum"] = None
            payload["size"] = None
        else:
            payload["missing"] = False
            payload["checksum"] = info.get("checksum")
            payload["size"] = info.get("size")
        files[f"media/{handle}.json"] = dumps(payload)
        media_properties[handle] = {
            "checksum": payload["checksum"], "size": payload["size"], "missing": payload["missing"],
        }
        media_manifest.append(
            {
                "handle": handle,
                "grampsId": media.get("gramps_id"),
                "s3Key": payload["s3Key"],
                "checksum": payload["checksum"],
                "size": payload["size"],
                "missing": payload["missing"],
            }
        )

    # Person payloads carry the media metadata too (the live ETL writes each person file a second time).
    for gramps_id, payload in person_payloads.items():
        for media_item in payload.get("mediaGallery", []):
            props = media_properties.get(media_item.get("handle", ""), {})
            media_item["checksum"] = props.get("checksum")
            media_item["size"] = props.get("size")
            # A transform `missing` stub (no media object rendered) has no props; keep its flag.
            media_item["missing"] = props.get("missing", media_item.get("missing", False))
        primary = payload.get("primaryPhoto")
        if isinstance(primary, dict):
            props = media_properties.get(primary.get("handle", ""), {})
            primary["checksum"] = props.get("checksum")
            primary["size"] = props.get("size")
            primary["missing"] = props.get("missing", primary.get("missing", False))
        files[f"person/{gramps_id}.json"] = dumps(payload)

    # Manifests. The live ETL lists places and media in the order it met them, which depends on set iteration order;
    # the renderer lists them by (Gramps ID, handle).
    files["place/index.json"] = dumps(sorted(place_manifest, key=_manifest_order))
    files["media/index.json"] = dumps(sorted(media_manifest, key=_manifest_order))

    # build_search_index.js: person/index.json is the search manifest (it replaces the ETL's own), plus the documents.
    person_files = {f"{gramps_id}.json": payload for gramps_id, payload in person_payloads.items()}
    files.update(search_index.build_search_files(person_files, generated_at))

    ordered = {key: files[key] for key in sorted(files)}
    for key in ordered:
        prefix = key.split("/", 1)[0]
        report.files[prefix] = report.files.get(prefix, 0) + 1
    return RenderResult(files=ordered, report=report)


def render_site(
    objects: Objects,
    *,
    media_files: Optional[MediaFiles] = None,
    generated_at: str = DEFAULT_GENERATED_AT,
    text_gate: Optional[TextGate] = None,
) -> Dict[str, bytes]:
    """The rendered site as ``{s3_key: bytes}``.

    ``objects``: the redaction projection's store view, ``{handle: Gramps-6 object}`` or an iterable of objects.
    ``media_files``: ``{media handle: {"checksum": sha256 hex, "size": bytes, "ext": ".jpg"}}`` for the blobs that exist;
    a media object with no entry (or ``None``) renders ``missing: true``. ``ext`` is optional (else the extension comes
    from ``Media.path``, then from the mime type). ``generated_at``: the ``at`` of the head change.
    ``text_gate``: ``str -> bool``, True when a free text may be published (default: the R-18 detector finds nothing).
    """

    return render(objects, media_files=media_files, generated_at=generated_at, text_gate=text_gate).files
