"""The top-level keys of the ten object classes the website holds (error catalog D39, BRD2 11.1 section 17).

A pull or a push meets an object from a newer website with a key this addon does not know (a field a later Gramps or a later sync
version added). The addon cannot apply it, and a push built from the local copy would drop the field from the website, so the
object is parked: left as the desktop has it, listed under `deferred` in the preview, and the rest of the run goes on. The fix is to
update the addon.

`KNOWN_FIELDS` is the `properties` of each class in gramps/schema/gramps-6.0.6.schema.json (the Gramps schema export, HFY-TSK-231), copied
so the installed addon needs no repository file. A unit test (test_sync_catalog_rows.py) compares the two, so a schema regeneration that
adds a key fails until this table follows. Only the top level is checked: a key nested inside a list element is not.
"""

KNOWN_FIELDS = {
    "Tag": frozenset(["_class", "change", "color", "handle", "name", "priority"]),
    "Place": frozenset([
        "_class", "alt_loc", "alt_names", "change", "citation_list", "code", "gramps_id", "handle", "lat", "long",
        "media_list", "name", "note_list", "place_type", "placeref_list", "private", "tag_list", "title", "urls",
    ]),
    "Note": frozenset(["_class", "change", "format", "gramps_id", "handle", "private", "tag_list", "text", "type"]),
    "Source": frozenset([
        "_class", "abbrev", "attribute_list", "author", "change", "gramps_id", "handle", "media_list", "note_list",
        "private", "pubinfo", "reporef_list", "tag_list", "title",
    ]),
    "Repository": frozenset([
        "_class", "address_list", "change", "gramps_id", "handle", "name", "note_list", "private", "tag_list", "type",
        "urls",
    ]),
    "Citation": frozenset([
        "_class", "attribute_list", "change", "confidence", "date", "gramps_id", "handle", "media_list", "note_list",
        "page", "private", "source_handle", "tag_list",
    ]),
    "Media": frozenset([
        "_class", "attribute_list", "change", "checksum", "citation_list", "date", "desc", "gramps_id", "handle", "mime",
        "note_list", "path", "private", "tag_list", "thumb",
    ]),
    "Event": frozenset([
        "_class", "attribute_list", "change", "citation_list", "date", "description", "gramps_id", "handle", "media_list",
        "note_list", "place", "private", "tag_list", "type",
    ]),
    "Person": frozenset([
        "_class", "address_list", "alternate_names", "attribute_list", "birth_ref_index", "change", "citation_list",
        "death_ref_index", "event_ref_list", "family_list", "gender", "gramps_id", "handle", "lds_ord_list", "media_list",
        "note_list", "parent_family_list", "person_ref_list", "primary_name", "private", "tag_list", "urls",
    ]),
    "Family": frozenset([
        "_class", "attribute_list", "change", "child_ref_list", "citation_list", "complete", "event_ref_list",
        "father_handle", "gramps_id", "handle", "lds_ord_list", "media_list", "mother_handle", "note_list", "private",
        "tag_list", "type",
    ]),
}


def unknown_fields(cls, obj):
    """The sorted top-level keys of `obj` that the addon does not know for its class; [] for a tombstone or a non-object.
    A class the addon does not know has no entry here: the snapshot parser parks those before they reach an object."""
    known = KNOWN_FIELDS.get(cls)
    if known is None or not isinstance(obj, dict):
        return []
    return sorted(k for k in obj if k not in known)
