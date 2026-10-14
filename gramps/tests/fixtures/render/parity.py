"""The inputs of the renderer parity run (HFY-TSK-229). Standard library only.

``p_fixture()`` is ``P(synthetic-fixture-tree)``: the tree the renderer and the live ETL are both fed.

* It starts from the committed synthetic tree (``synthetic-tree.jsonl``) and adds ``supplement()``, a few fictional objects
  for what the tree does not cover: the note vectors, MediaRef attributes, notes and citations, a custom family-event
  role, an unknown-type event and a dangling MediaRef.
* ``project()`` is a stand-in for the redaction projection of sync.md section 5.1 (``projection-py``, a later task).
  It does only what 5.1 says about the private flag and about holds: it drops private and held objects, drops private
  secondary elements, and filters every reference to a dropped object. It does NOT apply 5.2 to 5.5 (birth-like dates,
  contact data, street-level places, coordinates), so the renderer's own rules for street-level and home-like places show
  up in the expected-delta list, and the legacy ETL's year-only dates (HFY-R76) are what keep birth days out of both sides.
  It keeps ``Media.path`` because the live ETL reads the blob from it; the real projection blanks it and the renderer is
  then given the stored extension through ``media_files``.

``HELD`` says what the real projection would hold on this tree. Nothing here is real data.
"""

import hashlib
import json
import os
import sys
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.dirname(HERE)
GRAMPS = os.path.dirname(os.path.dirname(FIXTURES))
sys.path.insert(0, GRAMPS)

from hfygramps import scanner  # noqa: E402  (the R-18 detector; standard library only)

JSONL = os.path.join(FIXTURES, "synthetic-tree.jsonl")

# The tree's media blobs live beside it; Media.path is relative to this folder (``media/<name>``).
MEDIA_DIR = FIXTURES

#: Gramps IDs of Media whose blob the projection holds (EXIF GPS): the metadata renders, the blob does not exist.
HELD_BLOB_MEDIA_IDS = ("O0002",)
#: Gramps IDs of Media the projection holds whole: a birth-certificate PDF and a private scan (mime application/pdf).
HELD_PDF_MIME = "application/pdf"


def h(name):
    """A fictional 28-hex handle, stable for a name."""
    return hashlib.sha1(("hfy-render-parity:" + name).encode("utf-8")).hexdigest()[:28]


def load_jsonl(path=JSONL):
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


# ---- the supplement ---------------------------------------------------------------------------------------------

EPOCH = 1700000000


def _date(year=0, month=0, day=0, text=""):
    sortval = 0
    if year and month and day:
        sortval = date(year, month, day).toordinal() + 1721425
    elif year:
        sortval = date(year, 1, 1).toordinal() + 1721425
    return {"_class": "Date", "calendar": 0, "dateval": [day, month, year, False], "format": None, "modifier": 0,
            "newyear": 0, "quality": 0, "sortval": sortval, "text": text}


def _typed(cls, value, string=""):
    return {"_class": cls, "string": string, "value": value}


def _place(gid, name, ptype, parent=None, ptype_string=""):
    return {"_class": "Place", "alt_loc": [], "alt_names": [], "change": EPOCH, "citation_list": [], "code": "",
            "gramps_id": gid, "handle": h(gid), "lat": "", "long": "", "media_list": [], "name": {
                "_class": "PlaceName", "date": _date(), "lang": "", "value": name}, "note_list": [], "place_type":
            _typed("PlaceType", ptype, ptype_string), "placeref_list": (
                [{"_class": "PlaceRef", "date": _date(), "ref": h(parent)}] if parent else []), "private": False,
            "tag_list": [], "title": name, "urls": []}


def _event(gid, etype, year=0, month=0, day=0, place=None, etype_string="", description="", notes=()):
    return {"_class": "Event", "attribute_list": [], "change": EPOCH, "citation_list": [], "date": _date(year, month, day),
            "description": description, "gramps_id": gid, "handle": h(gid), "media_list": [], "note_list": [h(n) for n in notes],
            "place": h(place) if place else "", "private": False, "tag_list": [],
            "type": _typed("EventType", etype, etype_string) if etype is not None else None}


def _event_ref(gid, role=1, role_string="", private=False):
    return {"_class": "EventRef", "attribute_list": [], "citation_list": [], "note_list": [], "private": private,
            "ref": h(gid), "role": _typed("EventRoleType", role, role_string)}


def _tag(code, ranges, value=True):
    return {"_class": "StyledTextTag", "name": _typed("StyledTextTagType", code), "ranges": ranges, "value": value}


def _note(gid, string, tags=(), legacy_shape=False, private=False):
    if legacy_shape:
        text = {"_class": "StyledText", "_string": string, "_tags": list(tags)}
    else:
        text = {"_class": "StyledText", "string": string, "tags": list(tags)}
    return {"_class": "Note", "change": EPOCH, "format": 0, "gramps_id": gid, "handle": h(gid), "private": private,
            "tag_list": [], "text": text, "type": _typed("NoteType", 4)}


def _name(first, surname):
    return {"_class": "Name", "call": "", "citation_list": [], "date": _date(), "display_as": 0, "famnick": "",
            "first_name": first, "group_as": "", "nick": "", "note_list": [], "private": False, "sort_as": 0,
            "suffix": "", "surname_list": [{"_class": "Surname", "connector": "", "origintype": _typed(
                "NameOriginType", 1), "prefix": "", "primary": True, "surname": surname}],
            "title": "", "type": _typed("NameType", 2)}


def _person(gid, first, surname, gender, events=(), birth=-1, death=-1, families=(), parents=(), media=(), notes=()):
    return {"_class": "Person", "address_list": [], "alternate_names": [], "attribute_list": [], "birth_ref_index": birth,
            "change": EPOCH, "citation_list": [], "death_ref_index": death, "event_ref_list": list(events),
            "family_list": [h(f) for f in families], "gender": gender, "gramps_id": gid, "handle": h(gid), "lds_ord_list": [],
            "media_list": list(media), "note_list": [h(n) for n in notes], "parent_family_list": [h(f) for f in parents],
            "person_ref_list": [], "primary_name": _name(first, surname), "private": False, "tag_list": [], "urls": []}


def _attribute(code, value, string="", private=False):
    return {"_class": "Attribute", "citation_list": [], "note_list": [], "private": private,
            "type": _typed("AttributeType", code, string), "value": value}


def _media_ref(media, rect, attributes=(), notes=(), citations=(), private=False):
    return {"_class": "MediaRef", "attribute_list": list(attributes), "citation_list": [h(c) for c in citations],
            "note_list": [h(n) for n in notes], "private": private, "rect": rect, "ref": media if media.startswith("ghost") else h(media)}


def _citation(gid, source, private=False):
    return {"_class": "Citation", "attribute_list": [], "change": EPOCH, "confidence": 2, "date": _date(), "gramps_id": gid,
            "handle": h(gid), "media_list": [], "note_list": [], "page": "", "private": private, "source_handle": h(source),
            "tag_list": []}


def _source(gid, title, private=False):
    return {"_class": "Source", "abbrev": "", "attribute_list": [], "author": "", "change": EPOCH, "gramps_id": gid,
            "handle": h(gid), "media_list": [], "note_list": [], "private": private, "pubinfo": "", "reporef_list": [],
            "tag_list": [], "title": title}


def _child_ref(person, frel, mrel, frel_string="", mrel_string=""):
    return {"_class": "ChildRef", "citation_list": [], "frel": _typed("ChildRefType", frel, frel_string),
            "mrel": _typed("ChildRefType", mrel, mrel_string), "note_list": [], "private": False, "ref": h(person)}


def supplement():
    """Fictional objects for the cases the synthetic tree leaves out. Every ID starts with 9."""
    objs = []
    # Places: a country, a city, a street-level place and a custom home-like one under the city, a custom kept one.
    objs += [
        _place("P9001", "Vectorland", 1),
        _place("P9002", "Notecity", 4, "P9001"),
        _place("P9003", "Quill Lane", 7, "P9002"),
        _place("P9004", "The Summer Home", 0, "P9002", "Summer Home"),
        _place("P9005", "Lamp Landmark", 0, "P9002", "Landmark"),
    ]
    # Notes: the golden note vectors (script, img onerror, overlapping ranges, javascript: link, non-hex colour, sizes).
    objs += [
        _note("N9001", "Hello <script>alert(1)</script> world"),
        _note("N9002", 'Look <img src=x onerror=alert(2)> here & "there"'),
        _note("N9003", "Alpha beta gamma delta epsilon", [_tag(0, [[0, 10]]), _tag(1, [[6, 16]]), _tag(2, [[8, 12], [20, 29]])]),
        _note("N9004", "Click here or here", [_tag(8, [[6, 10]], "javascript:alert(3)"), _tag(8, [[14, 18]], "https://notes.example.org/ok")]),
        _note("N9005", "Red words and blue words", [_tag(5, [[0, 9]], "red"), _tag(5, [[10, 14]], "#A1B2C3"), _tag(6, [[15, 24]], "#ff0")]),
        _note("N9006", "small medium large huge", [_tag(4, [[0, 5]], "10"), _tag(4, [[6, 12]], "18"), _tag(4, [[13, 18]], "30"), _tag(4, [[19, 23]], "x")]),
        _note("N9007", "Legacy shape text with bold", [_tag(0, [[0, 6]])], legacy_shape=True),
        _note("N9008", "First paragraph.\r\n\r\nSecond paragraph\nwith a break.\rThird."),
        _note("N9009", "Café über & <b>bold</b> – done"),
        _note("N9101", "Standing at the left of the porch."),
        _note("N9102", "Ask the desk on 555-0188 about this one."),
        _note("N9103", "A private remark about the photo.", private=True),
    ]
    objs += [
        _source("S9001", "Fixture Photo Archive"),
        _source("S9002", "Archive desk 555-0144 copy"),
        _source("S9003", "A private archive", private=True),
        _citation("C9001", "S9001"),
        _citation("C9002", "S9002"),
        _citation("C9003", "S9001", private=True),
        _citation("C9004", "S9003"),
        _citation("C9005", "S9001"),
    ]
    objs.append({"_class": "Media", "attribute_list": [], "change": EPOCH, "checksum": "", "citation_list": [], "date": _date(),
                 "desc": "Porch group photo (fictional)", "gramps_id": "O9001", "handle": h("O9001"), "mime": "image/jpeg",
                 "note_list": [], "path": "media/synthetic-photo-plain.jpg", "private": False, "tag_list": [], "thumb": None})
    # Events.
    objs += [
        _event("E9001", 42, 1950, 6, 15, "P9003", description="Moved into the lane house"),   # street-level place
        _event("E9002", 0, 1960, 0, 0, "P9005", "Fixture Gathering"),                         # custom type, kept place
        _event("E9003", 13, 1999, 2, 3, "P9002"),
        _event("E9004", 42, 0, 0, 0, "P9004"),                                                # no date, home-like place
        _event("E9005", 26),                                                                  # Education, no date, same sortval as E9004
        _event("E9006", None, 1971, 0, 0),                                                    # no type: label falls back by index
        _event("E9007", 1, 1975, 8, 9, "P9002"),                                              # family marriage
        _event("E9008", 0, 1976, 0, 0, "P9004", "Fixture Ceremony"),                          # family, home-like place, custom type
        _event("E9009", 12, 1949, 5, 4, "P9002"),
        _event("E9010", 12, 1976, 3, 3, "P9001"),
    ]
    quill_media = [
        _media_ref("O9001", [5, 5, 45, 95],
                   attributes=[_attribute(2, "Standing at left"), _attribute(10, "47"), _attribute(0, "Secret", "Mood", private=True),
                               _attribute(0, "Cheerful", "Mood"), _attribute(0, "Call 555-0123", "Contact")],
                   notes=["N9101", "N9102", "N9103"], citations=["C9001", "C9002", "C9003", "C9004", "C9005"]),
        _media_ref("ghost-media-handle-0001", [1, 2, 3, 4]),
    ]
    rowan_media = [_media_ref("O9001", [50, 5, 95, 95], notes=["N9101"], citations=["C9001"])]
    objs += [
        _person("I9001", "Quill", "Notevector", 1, [_event_ref("E9009"), _event_ref("E9001"), _event_ref("E9002"), _event_ref("E9003"),
                                                       _event_ref("E9004"), _event_ref("E9005"), _event_ref("E9006")],
                birth=0, death=3, families=["F9001"], media=quill_media, notes=["N9001", "N9002", "N9003", "N9004", "N9005",
                                                                                  "N9006", "N9007", "N9008", "N9009", "N9102"]),
        _person("I9002", "Rowan", "Tagvector", 0, [_event_ref("E9010")], birth=0, families=["F9001"], media=rowan_media),
        _person("I9003", "Sage", "Notevector", 2, [], parents=["F9001"]),
        _person("I9004", "Wren", "Notevector", 0, [], parents=["F9001"]),
    ]
    objs.append({"_class": "Family", "attribute_list": [], "change": EPOCH, "child_ref_list": [
        _child_ref("I9003", 2, 5), _child_ref("I9004", 7, 1, frel_string="Fixture ward")],
        "citation_list": [], "complete": 0, "event_ref_list": [_event_ref("E9007", 8), _event_ref("E9008", 0, "Fixture Role")],
        "father_handle": h("I9001"), "gramps_id": "F9001", "handle": h("F9001"), "lds_ord_list": [], "media_list": [],
        "mother_handle": h("I9002"), "note_list": [], "private": False, "tag_list": [], "type": _typed("FamilyRelType", 2)})
    return objs


# ---- the stand-in projection ----------------------------------------------------------------------------------------

def _text_of(note):
    text = note.get("text") or {}
    return text.get("string") if text.get("string") is not None else text.get("_string") or ""


def held_handles(objects):
    """What the real projection would hold on this tree: a person whose primary name is private, a PDF, a note with a finding."""
    held = set()
    for obj in objects:
        cls = obj["_class"]
        if cls == "Person" and (obj.get("primary_name") or {}).get("private"):
            held.add(obj["handle"])
        elif cls == "Media" and obj.get("mime") == HELD_PDF_MIME:
            held.add(obj["handle"])
        elif cls == "Note" and scanner.scan_text(_text_of(obj)):
            held.add(obj["handle"])
    return held


def _walk(value, dropped):
    """Remove private list elements and references to dropped handles, in place, anywhere in ``value``."""
    if isinstance(value, dict):
        for key in ("father_handle", "mother_handle", "place", "source_handle"):
            if value.get(key) in dropped:
                value[key] = None if key in ("father_handle", "mother_handle") else ""
        for key, child in list(value.items()):
            if isinstance(child, list):
                kept = []
                for item in child:
                    if isinstance(item, dict) and (item.get("private") or item.get("ref") in dropped):
                        continue
                    if isinstance(item, str) and item in dropped and key in (
                            "note_list", "citation_list", "family_list", "parent_family_list", "media_list", "event_ref_list"):
                        continue
                    kept.append(item)
                value[key] = kept
            _walk(value[key], dropped)
    elif isinstance(value, list):
        for item in value:
            _walk(item, dropped)


def project(objects):
    """Section 5.1 only (see the module docstring). Returns new objects; the input is not touched."""
    objs = json.loads(json.dumps(objects))
    held = held_handles(objs)
    dropped = held | {o["handle"] for o in objs if o.get("private")}
    kept = [o for o in objs if o["handle"] not in dropped]
    originals = {o["handle"]: list(o.get("event_ref_list") or []) for o in kept if o["_class"] == "Person"}
    for obj in kept:
        _walk(obj, dropped)
    for obj in kept:
        if obj["_class"] != "Person":
            continue
        # Dropping event refs shifts the positions the indexes point at (the real projection recomputes them too).
        before, after = originals[obj["handle"]], obj["event_ref_list"]
        for field in ("birth_ref_index", "death_ref_index"):
            idx = obj.get(field, -1)
            target = before[idx] if isinstance(idx, int) and 0 <= idx < len(before) else None
            obj[field] = next((i for i, ref in enumerate(after) if ref is target), -1)
    return kept


def p_fixture():
    return project(load_jsonl() + supplement())


# ---- media blobs ---------------------------------------------------------------------------------------------------

def media_files(objects, media_dir=MEDIA_DIR):
    """``{handle: {"checksum", "size", "ext"}}`` for the Media whose blob exists and is not held; the renderer's ``media_files``."""
    out = {}
    held_ids = set(HELD_BLOB_MEDIA_IDS)
    for obj in objects:
        if obj["_class"] != "Media" or obj.get("gramps_id") in held_ids:
            continue
        path = os.path.join(media_dir, obj.get("path") or "")
        if not obj.get("path") or not os.path.isfile(path):
            continue
        with open(path, "rb") as fh:
            data = fh.read()
        out[obj["handle"]] = {"checksum": hashlib.sha256(data).hexdigest(), "size": len(data),
                              "ext": os.path.splitext(obj["path"])[1].lower() or None}
    return out
