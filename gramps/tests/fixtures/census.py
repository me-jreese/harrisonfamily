"""Census of the synthetic fixture tree (HFY-TSK-228). Standard library only.

`run_census(objects)` returns {case: [gramps ids that show it]} over the parsed
synthetic-tree.jsonl. REQUIRED_CASES is the list sync.md section 15 and the review
scenarios call for; `missing(result)` names every case with no hit. The generator writes
the result to synthetic-tree.census.json and the unit test fails on any missing case, so a
fixture edit that drops a case cannot go unnoticed. No Gramps import here: the check runs
anywhere Python 3.12+ does.
"""
import hashlib
import json
import os
import re

GENERATED_FILES = [
    "synthetic-tree.gramps",
    "synthetic-tree.jsonl",
    "synthetic-tree.census.json",
]
MEDIA_FILES = [
    "synthetic-photo-gps.jpg",
    "synthetic-photo-plain.jpg",
    "synthetic-placeholder.jpg",
    "synthetic-birth-certificate.pdf",
]
CHECKSUM_FILE = "synthetic-tree.sha256"
ALL_FILES = GENERATED_FILES + ["media/" + n for n in MEDIA_FILES] + [CHECKSUM_FILE]

# Gramps 6.0 enum values (gramps/gen/lib/*type.py).
EV_CUSTOM, EV_MARRIAGE, EV_DIVORCE = 0, 1, 7
EV_BIRTH, EV_DEATH, EV_BAPTISM, EV_BLESS, EV_CHRISTEN, EV_STILLBIRTH = 12, 13, 15, 18, 22, 45
MOD_RANGE, MOD_SPAN, MOD_TEXTONLY = 4, 5, 6
PLACE_CUSTOM, PLACE_STREET, PLACE_FARM, PLACE_BUILDING = 0, 7, 18, 19
URL_EMAIL = 1
ATTR_ID, ATTR_SSN, ATTR_AGE, ATTR_FATHER_AGE, ATTR_MOTHER_AGE, ATTR_TIME = 3, 6, 10, 11, 12, 14
CHILD_REL_BIRTH, CHILD_REL_CUSTOM = 1, 7
BIRTH_LIKE = {EV_BIRTH, EV_BAPTISM, EV_BLESS, EV_CHRISTEN, EV_STILLBIRTH}
CONTACT_HOSTS = ("wa.me", "m.me", "t.me", "ig.me", "telegram.me", "messenger.com", "signal.me")

PHONE_RE = re.compile(r"\b555-01\d\d\b")
EMAIL_RE = re.compile(r"[\w.+-]+@example\.org")
STREET_RE = re.compile(r"\b\d+ [A-Z][a-z]+ (Road|Street|Lane)\b")
DOB_PROSE_RE = re.compile(r"[Bb]orn on \d{1,2} [A-Z][a-z]+ \d{4}")


def load_jsonl(path):
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def _by_class(objects):
    out = {}
    for o in objects:
        out.setdefault(o["_class"], []).append(o)
    return out


def _walk(node):
    """Every dict in a nested JSON value, depth first."""
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from _walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk(v)


def _strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for v in node.values():
            yield from _strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from _strings(v)


def referrers(objects):
    """handle -> sorted gramps ids of the objects that mention it (not counting the object itself)."""
    handles = {o["handle"] for o in objects}
    refs = {}
    for o in objects:
        for key, value in o.items():
            if key == "handle":
                continue
            for s in _strings(value):
                if s in handles and s != o["handle"]:
                    refs.setdefault(s, set()).add(o.get("gramps_id") or o.get("name"))
    return {h: sorted(v) for h, v in refs.items()}


def date_is_full(d):
    """A day-precise date: a non-zero day and month on a plain, range or span date."""
    if not d or d.get("modifier") == MOD_TEXTONLY:
        return False
    v = d.get("dateval") or []
    if len(v) >= 3 and v[0] and v[1] and v[2]:
        return True
    return len(v) >= 7 and bool(v[4] and v[5] and v[6])


def _ids(objs):
    return sorted(o["gramps_id"] for o in objs)


def run_census(objects):
    c = _by_class(objects)
    persons = c.get("Person", [])
    families = c.get("Family", [])
    events = c.get("Event", [])
    places = c.get("Place", [])
    notes = c.get("Note", [])
    media = c.get("Media", [])
    cites = c.get("Citation", [])
    repos = c.get("Repository", [])
    ev_by_handle = {e["handle"]: e for e in events}
    refs = referrers(objects)
    res = {}

    def person_events(p):
        return [ev_by_handle.get(r["ref"]) for r in p.get("event_ref_list", []) if ev_by_handle.get(r["ref"])]

    def birth_event(p):
        i = p.get("birth_ref_index", -1)
        lst = p.get("event_ref_list", [])
        return ev_by_handle.get(lst[i]["ref"]) if 0 <= i < len(lst) else None

    def persons_with_event(pred):
        return _ids(p for p in persons if any(pred(e) for e in person_events(p)))

    def etype(e):
        return e["type"]["value"]

    def estring(e):
        return e["type"].get("string", "")

    def note_text(n):
        return n["text"]["string"]

    # --- dates of birth and birth-like events
    res["birth_full_date"] = persons_with_event(lambda e: etype(e) == EV_BIRTH and date_is_full(e["date"]))
    res["baptism_deceased_with_day"] = _ids(
        p for p in persons
        if any(etype(e) == EV_BAPTISM and date_is_full(e["date"]) for e in person_events(p))
        and any(etype(e) == EV_DEATH for e in person_events(p))
        and not any(etype(e) == EV_BIRTH for e in person_events(p)))
    res["christening_event"] = persons_with_event(lambda e: etype(e) == EV_CHRISTEN)
    res["blessing_event"] = persons_with_event(lambda e: etype(e) == EV_BLESS)
    res["stillbirth_event"] = persons_with_event(lambda e: etype(e) == EV_STILLBIRTH)
    res["custom_birth_like_event"] = persons_with_event(
        lambda e: etype(e) == EV_CUSTOM and re.search(r"birth|bapt|christen|naissance|geburt|nacimiento", estring(e), re.I))
    res["custom_non_birth_event"] = persons_with_event(
        lambda e: etype(e) == EV_CUSTOM and not re.search(r"birth|bapt|christen|naissance|geburt|nacimiento", estring(e), re.I))
    res["birth_retype_target"] = _ids(
        p for p in persons if (birth_event(p) or {}).get("description", "").startswith("Retype to Residence"))
    res["range_birth_date"] = persons_with_event(lambda e: etype(e) == EV_BIRTH and e["date"]["modifier"] == MOD_RANGE)
    res["textonly_birth_date"] = persons_with_event(lambda e: etype(e) == EV_BIRTH and e["date"]["modifier"] == MOD_TEXTONLY)
    res["span_date"] = persons_with_event(lambda e: e["date"]["modifier"] == MOD_SPAN)
    res["birth_citation_full_date"] = _ids(
        p for p in persons
        if any(etype(e) == EV_BIRTH and any(
            date_is_full(x["date"]) for x in cites if x["handle"] in e.get("citation_list", []))
            for e in person_events(p)))
    res["birth_name_with_date"] = _ids(
        p for p in persons
        if p["primary_name"]["type"]["value"] == 2 and date_is_full(p["primary_name"].get("date")))
    res["family_events"] = _ids(
        f for f in families if any(ev_by_handle.get(r["ref"]) for r in f.get("event_ref_list", [])))
    res["marriage_and_divorce_events"] = _ids(
        f for f in families
        if {etype(ev_by_handle[r["ref"]]) for r in f.get("event_ref_list", []) if r["ref"] in ev_by_handle}
        >= {EV_MARRIAGE, EV_DIVORCE})

    # --- private flags, at every level
    res["private_person"] = _ids(p for p in persons if p["private"])
    res["private_primary_name"] = _ids(p for p in persons if p["primary_name"]["private"])
    res["private_family"] = _ids(f for f in families if f["private"])
    res["private_child_ref"] = _ids(f for f in families if any(r["private"] for r in f.get("child_ref_list", [])))
    res["private_alternate_name"] = _ids(p for p in persons if any(n["private"] for n in p.get("alternate_names", [])))
    res["private_event_ref"] = _ids(
        x for x in persons + families if any(r["private"] for r in x.get("event_ref_list", [])))
    res["private_media_ref"] = _ids(p for p in persons if any(r["private"] for r in p.get("media_list", [])))
    res["private_attribute"] = _ids(p for p in persons if any(a["private"] for a in p.get("attribute_list", [])))
    res["private_address"] = _ids(p for p in persons if any(a["private"] for a in p.get("address_list", [])))
    res["private_url"] = _ids(p for p in persons if any(u["private"] for u in p.get("urls", [])))
    res["private_lds_ord"] = _ids(p for p in persons if any(o["private"] for o in p.get("lds_ord_list", [])))
    res["private_person_ref"] = _ids(p for p in persons if any(r["private"] for r in p.get("person_ref_list", [])))
    res["private_event"] = _ids(e for e in events if e["private"])
    res["private_note"] = _ids(n for n in notes if n["private"])
    res["private_media"] = _ids(m for m in media if m["private"])
    res["private_citation"] = _ids(x for x in cites if x["private"])

    def exclusive_to(handle, owner_id):
        return refs.get(handle, []) == [owner_id]

    excl = []
    for p in persons:
        if not p["private"]:
            continue
        be = birth_event(p)
        has_ev = bool(be and be["private"] and exclusive_to(be["handle"], p["gramps_id"]))
        has_note = any(exclusive_to(h, p["gramps_id"]) and n["private"] for h in p.get("note_list", [])
                       for n in notes if n["handle"] == h)
        has_media = any(exclusive_to(r["ref"], p["gramps_id"]) for r in p.get("media_list", []))
        if has_ev and has_note and has_media:
            excl.append(p)
    res["private_person_exclusive_event_note_photo"] = _ids(excl)

    # --- places
    res["farm_place"] = _ids(x for x in places if x["place_type"]["value"] == PLACE_FARM)
    res["custom_home_place"] = _ids(
        x for x in places if x["place_type"]["value"] == PLACE_CUSTOM and x["place_type"]["string"] == "Home")
    res["place_six_decimal_coordinates"] = _ids(
        x for x in places
        if all(re.fullmatch(r"-?\d+\.\d{6}", x.get(k) or "") for k in ("lat", "long")))
    res["street_place_with_alt_loc_fields"] = _ids(
        x for x in places
        if x["place_type"]["value"] == PLACE_STREET and any(
            l.get("street") and l.get("phone") and l.get("postal") for l in x.get("alt_loc", [])))
    res["building_place"] = _ids(x for x in places if x["place_type"]["value"] == PLACE_BUILDING)

    # --- contact data
    res["person_address"] = _ids(p for p in persons if any(not a["private"] for a in p.get("address_list", [])))
    res["repository_address"] = _ids(r for r in repos if r.get("address_list"))
    res["url_email_type"] = _ids(p for p in persons if any(u["type"]["value"] == URL_EMAIL for u in p.get("urls", [])))
    res["url_contact_channel"] = _ids(
        p for p in persons if any(
            u["path"].startswith(("tel:", "mailto:", "sms:")) or any(h in u["path"] for h in CONTACT_HOSTS)
            for u in p.get("urls", [])))
    res["url_shared_search"] = _ids(
        p for p in persons if any(u["type"]["value"] != URL_EMAIL and u["path"].startswith("https://example.org/search")
                                  for u in p.get("urls", [])))
    res["note_with_phone"] = _ids(n for n in notes if PHONE_RE.search(note_text(n)))
    res["note_with_email"] = _ids(n for n in notes if EMAIL_RE.search(note_text(n)))
    res["note_with_street_address"] = _ids(n for n in notes if STREET_RE.search(note_text(n)))
    res["note_with_dob_prose"] = _ids(n for n in notes if DOB_PROSE_RE.search(note_text(n)))
    res["styled_note_tags"] = _ids(n for n in notes if n["text"].get("tags"))

    # --- attributes
    def attr_types(p):
        return {a["type"]["value"] for a in p.get("attribute_list", [])}

    res["attribute_age"] = _ids(p for p in persons if ATTR_AGE in attr_types(p))
    res["attribute_father_age"] = _ids(p for p in persons if ATTR_FATHER_AGE in attr_types(p))
    res["attribute_mother_age"] = _ids(p for p in persons if ATTR_MOTHER_AGE in attr_types(p))
    res["attribute_time"] = _ids(p for p in persons if ATTR_TIME in attr_types(p))
    res["attribute_ssn"] = _ids(p for p in persons if ATTR_SSN in attr_types(p))
    res["attribute_id"] = _ids(p for p in persons if ATTR_ID in attr_types(p))
    res["attribute_merged_id"] = _ids(
        p for p in persons if any(a["type"]["string"] == "Merged Gramps ID" for a in p.get("attribute_list", [])))

    # --- relationships
    res["lds_ordinance"] = _ids(p for p in persons if p.get("lds_ord_list"))
    res["person_association"] = _ids(p for p in persons if p.get("person_ref_list"))
    res["tag_objects_in_use"] = _ids(
        x for x in persons + families if x.get("tag_list"))
    res["family_every_father_relation"] = (
        ["all"] if {r["frel"]["value"] for f in families for r in f.get("child_ref_list", [])} >= set(range(1, 8)) else [])
    res["family_every_mother_relation"] = (
        ["all"] if {r["mrel"]["value"] for f in families for r in f.get("child_ref_list", [])} >= set(range(1, 8)) else [])
    res["family_custom_relation_type"] = _ids(f for f in families if f["type"]["value"] == 4 or f["type"]["string"])
    res["family_relation_types"] = (
        ["all"] if {f["type"]["value"] for f in families} >= {0, 1, 2, 3, 4} else [])

    # --- media
    def refs_of(x):
        return x.get("media_list", [])

    two_tags = []
    for p in persons:
        seen = {}
        for r in refs_of(p):
            if r.get("rect"):
                seen[r["ref"]] = seen.get(r["ref"], 0) + 1
        if any(n >= 2 for n in seen.values()):
            two_tags.append(p)
    res["two_tags_of_one_person_in_one_photo"] = _ids(two_tags)
    res["rect_full_frame_0_0_100_100"] = _ids(
        x for x in persons + families if any(r.get("rect") == [0, 0, 100, 100] for r in refs_of(x)))
    res["rect_float"] = _ids(
        x for x in persons + families if any(
            r.get("rect") and any(isinstance(v, float) and not float(v).is_integer() for v in r["rect"])
            for r in refs_of(x)))
    res["media_birth_certificate_pdf"] = _ids(
        m for m in media if m["mime"] == "application/pdf" and "irth certificate" in m["desc"])
    res["media_zero_byte_placeholder"] = _ids(m for m in media if m["path"].endswith("synthetic-placeholder.jpg"))
    res["media_jpeg_with_gps"] = _ids(m for m in media if m["path"].endswith("synthetic-photo-gps.jpg"))
    res["media_ref_on_family"] = _ids(f for f in families if refs_of(f))

    return res


def _required():
    # Every key run_census emits is a required case; a case that finds nothing is "missing".
    return [
        "birth_full_date", "baptism_deceased_with_day", "christening_event", "blessing_event", "stillbirth_event",
        "custom_birth_like_event", "custom_non_birth_event", "birth_retype_target", "range_birth_date",
        "textonly_birth_date", "span_date", "birth_citation_full_date", "birth_name_with_date", "family_events",
        "marriage_and_divorce_events", "private_person", "private_primary_name", "private_family",
        "private_child_ref", "private_alternate_name", "private_event_ref", "private_media_ref",
        "private_attribute", "private_address", "private_url", "private_lds_ord", "private_person_ref",
        "private_event", "private_note", "private_media", "private_citation",
        "private_person_exclusive_event_note_photo", "farm_place", "custom_home_place",
        "place_six_decimal_coordinates", "street_place_with_alt_loc_fields", "building_place", "person_address",
        "repository_address", "url_email_type", "url_contact_channel", "url_shared_search", "note_with_phone",
        "note_with_email", "note_with_street_address", "note_with_dob_prose", "styled_note_tags", "attribute_age",
        "attribute_father_age", "attribute_mother_age", "attribute_time", "attribute_ssn", "attribute_id",
        "attribute_merged_id", "lds_ordinance", "person_association", "tag_objects_in_use",
        "family_every_father_relation", "family_every_mother_relation", "family_custom_relation_type",
        "family_relation_types", "two_tags_of_one_person_in_one_photo", "rect_full_frame_0_0_100_100",
        "rect_float", "media_birth_certificate_pdf", "media_zero_byte_placeholder", "media_jpeg_with_gps",
        "media_ref_on_family",
    ]


REQUIRED_CASES = _required()


def missing(result):
    return [c for c in REQUIRED_CASES if not result.get(c)]


def sha256_file(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def read_checksums(path):
    out = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if line:
                digest, name = line.split("  ", 1)
                out[name] = digest
    return out


def verify_files(directory):
    """Names of the files whose sha256 differs from synthetic-tree.sha256 (or are missing)."""
    sums = read_checksums(os.path.join(directory, CHECKSUM_FILE))
    bad = []
    for name in sorted(set(sums) | set(ALL_FILES) - {CHECKSUM_FILE}):
        p = os.path.join(directory, name)
        if name not in sums or not os.path.isfile(p) or sha256_file(p) != sums[name]:
            bad.append(name)
    return bad
