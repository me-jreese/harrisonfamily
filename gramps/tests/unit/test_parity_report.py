"""hfy-parity, the counts-only shadow parity report (HFY-TSK-370).

Every tree here is synthetic (fabricated Gramps IDs, handles and names; nothing real). The tests run the real command line entry
point, ``hfyparity.cli.main``, on folders in a temporary directory: no network, no aws (the S3 path gets a fake runner).

Standard library only. Run: python3 -m unittest discover gramps/tests/unit
"""

import contextlib
import copy
import hashlib
import io
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
GRAMPS = os.path.dirname(os.path.dirname(HERE))
if GRAMPS not in sys.path:
    sys.path.insert(0, GRAMPS)

from hfyparity import cli, compare as compare_mod, rules, source  # noqa: E402

BIN = os.path.join(GRAMPS, "bin", "hfy-parity")
DOC = os.path.join(os.path.dirname(GRAMPS), "docs", "how-to", "review-the-shadow-parity-report.md")


# ---- a synthetic site ---------------------------------------------------------------------------------------------------

def hid(name):
    """A fabricated 28-hex handle, stable for a name."""
    return "%028x" % (0xFABC00000000 + sum(ord(c) * 131 ** i for i, c in enumerate(name)) % 0xFFFFFFFF)


def dumps(doc):
    return json.dumps(doc, indent=2, sort_keys=True, ensure_ascii=False).encode("utf-8")


def brief(place):
    return {"displayName": place["displayName"], "grampsId": place["grampsId"], "handle": place["handle"],
            "latitude": place["latitude"], "longitude": place["longitude"]}


def place_doc(gid, name, code, string, parents=(), lat=None, lon=None, postal=None):
    return {"code": postal, "displayName": name, "grampsId": gid, "handle": hid(gid), "latitude": lat, "longitude": lon,
            "parents": [brief(p) for p in parents], "type": {"code": code, "string": string}, "urls": []}


def event_doc(gid, label, code, string, text, year, place=None, description=None):
    return {"date": {"text": text, "year": year}, "description": description, "grampsId": gid, "handle": hid(gid),
            "label": label, "place": brief(place) if place else None, "type": {"code": code, "string": string}}


def note_doc(gid, raw, html):
    return {"grampsId": gid, "handle": hid(gid), "html": html, "raw": raw}


def media_doc(gid, mime, ext, title):
    return {"checksum": "0" * 64, "grampsId": gid, "handle": hid(gid), "mime": mime, "missing": False, "regions": [],
            "s3Key": "media/%s.%s" % (hid(gid), ext), "size": 12, "title": title}


def build_site():
    """The legacy side: two people, a family, events, a note, two media, four places and the four index files."""
    city = place_doc("P9001", "Testville", 4, "City")
    street = place_doc("P9002", "Test Lane", 7, "Street", parents=[city])
    home = place_doc("P9003", "Summer Home", 0, "Summer Home", parents=[city])
    hill = place_doc("P9004", "Landmark Hill", 0, "Landmark", parents=[street, city])
    birth = event_doc("E9001", "Birth", 12, "Birth", "1950", 1950, city)
    move = event_doc("E9002", "Residence", 33, "Residence", "1960", 1960, street)
    note = note_doc("N9001", "", "")
    photo = media_doc("O9001", "image/jpeg", "jpg", "Test Photo")
    scan = media_doc("O9002", "image/jpeg", "jpg", "Test Scan")
    people = [
        {"handle": hid("I9001"), "grampsId": "I9001", "displayName": "Test Person One", "events": [birth, move],
         "notes": [note], "mediaGallery": [], "lifespan": {"birth": {"year": 1950}, "summary": "1950"}},
        {"handle": hid("I9002"), "grampsId": "I9002", "displayName": "Test Person Two", "events": [],
         "notes": [], "mediaGallery": [], "lifespan": {"birth": {"year": 1952}, "summary": "1952"}},
    ]
    site = {}
    for person in people:
        site["person/%s.json" % person["grampsId"]] = dumps(person)
    for doc in (birth, move):
        site["event/%s.json" % doc["handle"]] = dumps({k: v for k, v in doc.items()})
    for doc in (city, street, home, hill):
        site["place/%s.json" % doc["handle"]] = dumps(doc)
    for doc in (photo, scan):
        site["media/%s.json" % doc["handle"]] = dumps(doc)
    site["note/%s.json" % note["handle"]] = dumps(note)
    site["family/%s.json" % hid("F9001")] = dumps({"grampsId": "F9001", "handle": hid("F9001"), "children": []})
    site["person/index.json"] = dumps({"count": 2, "generatedAt": "2000-01-01T00:00:00.000Z", "people": [
        {"handle": p["handle"], "grampsId": p["grampsId"], "displayName": p["displayName"]} for p in people]})
    site["person/search-index.json"] = dumps({"generatedAt": "2000-01-01T00:00:00.000Z", "documents": [
        {"grampsId": p["grampsId"], "searchText": p["displayName"].lower()} for p in people]})
    site["place/index.json"] = dumps([{"displayName": p["displayName"], "grampsId": p["grampsId"], "handle": p["handle"]}
                                      for p in (city, street, home, hill)])
    site["media/index.json"] = dumps([{"grampsId": m["grampsId"], "handle": m["handle"], "s3Key": m["s3Key"], "size": 12}
                                      for m in (photo, scan)])
    return site


def load(site, key):
    return json.loads(site[key].decode("utf-8"))


def put(site, key, doc):
    site[key] = dumps(doc)


def edit(site, key, fn):
    doc = load(site, key)
    fn(doc)
    put(site, key, doc)


PERSON1 = "person/I9001.json"
EVENT_BIRTH = "event/%s.json" % hid("E9001")
EVENT_MOVE = "event/%s.json" % hid("E9002")
NOTE = "note/%s.json" % hid("N9001")
PLACE_CITY = "place/%s.json" % hid("P9001")
PLACE_STREET = "place/%s.json" % hid("P9002")
PLACE_HOME = "place/%s.json" % hid("P9003")
PLACE_HILL = "place/%s.json" % hid("P9004")
MEDIA_SCAN = "media/%s.json" % hid("O9002")
MEDIA_PHOTO = "media/%s.json" % hid("O9001")


def write_tree(root, site):
    for key, data in site.items():
        path = os.path.join(root, *key.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)


class Capture:
    """stdout, stderr and the root logger's records of one run."""

    def __init__(self):
        self.out, self.err, self.logs = io.StringIO(), io.StringIO(), []

    @property
    def everything(self):
        return self.out.getvalue() + "\n" + self.err.getvalue() + "\n" + "\n".join(self.logs)


class _ListHandler(logging.Handler):
    def __init__(self, sink):
        super().__init__(logging.DEBUG)
        self.sink = sink

    def emit(self, record):
        self.sink.append(record.getMessage())


def run_cli(legacy, shadow, extra=(), run=None):
    """Run main() on two sites (dicts of key -> bytes; None = no folder). Returns (exit code, Capture)."""
    cap = Capture()
    root = logging.getLogger()
    handler, level = _ListHandler(cap.logs), root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            args = []
            for flag, site in (("--legacy", legacy), ("--shadow", shadow)):
                folder = os.path.join(tmp, flag[2:])
                if site is not None:
                    os.makedirs(folder)
                    write_tree(folder, site)
                args += [flag, folder]
            code = cli.main(args + list(extra), run=run or subprocess.run, out=cap.out, err=cap.err)
            cap.tmp = tmp
    finally:
        root.removeHandler(handler)
        root.setLevel(level)
    return code, cap


def report(legacy, shadow):
    code, cap = run_cli(legacy, shadow, ["--json"])
    return code, json.loads(cap.out.getvalue())


# ---- identical, normalised and not compared ---------------------------------------------------------------------------

class Identical(unittest.TestCase):
    def test_identical_trees_exit_zero(self):
        site = build_site()
        code, doc = report(site, copy.deepcopy(site))
        self.assertEqual(code, 0)
        self.assertEqual(doc["verdict"], "identical")
        self.assertEqual((doc["explained"], doc["unexplained"]), (0, 0))
        self.assertEqual(doc["files"]["identical"], len(site))
        self.assertEqual(doc["exit"], 0)

    def test_the_text_report_has_a_verdict_line_and_the_class_table(self):
        site = build_site()
        code, cap = run_cli(site, copy.deepcopy(site))
        lines = cap.out.getvalue().splitlines()
        self.assertEqual(lines[0], "hfy-parity: verdict=identical explained=0 unexplained=0 exit=0")
        self.assertTrue(any(line.startswith("only_in_legacy") for line in lines))
        self.assertEqual(cap.err.getvalue(), "")

    def test_generated_at_and_index_order_are_normalised_not_differences(self):
        legacy, shadow = build_site(), build_site()
        for key in ("person/index.json", "person/search-index.json"):
            edit(shadow, key, lambda d: d.update(generatedAt="2026-11-04T10:00:00.000Z"))
        edit(shadow, "person/index.json", lambda d: d["people"].reverse())
        edit(shadow, "place/index.json", lambda d: d.reverse())
        edit(shadow, "media/index.json", lambda d: d.reverse())
        code, doc = report(legacy, shadow)
        self.assertEqual(code, 0)
        self.assertEqual(doc["verdict"], "identical")
        self.assertEqual(doc["normalised"], {"index-generated-at": 2, "index-order": 3})
        self.assertEqual(doc["files"]["normalised_only"], 4)

    def test_files_the_renderer_does_not_own_are_counted_never_compared(self):
        legacy, shadow = build_site(), build_site()
        for key in ("media/%s.jpg" % hid("O9001"), "media/%s.png" % hid("O9002"), "media/faces/%s.png" % hid("x1"),
                    "media/tree_I9001.svg", "media/.staging/part", "person/index.html", "person/graph.json",
                    "person/search-store.json", "uploads/posts/a.jpg", "js/app.js", "media/deep/er/file.bin"):
            legacy[key] = b"binary \x00 not json"
        code, doc = report(legacy, shadow)
        self.assertEqual(code, 0)
        self.assertEqual(doc["not_compared"], {"graph-file": 2, "media-binary": 2, "media-faces": 1, "media-staging": 1,
                                               "other": 1, "shell-file": 2, "tree-svg": 1, "uploads": 1})

    def test_finder_litter_is_ignored(self):
        legacy, shadow = build_site(), build_site()
        legacy["person/.DS_Store"] = b"x"
        shadow["media/._junk"] = b"x"
        code, doc = report(legacy, shadow)
        self.assertEqual(code, 0)


# ---- one explained difference per rule -------------------------------------------------------------------------------

class Rules(unittest.TestCase):
    def explained(self, legacy, shadow):
        code, doc = report(legacy, shadow)
        self.assertEqual(doc["unexplained"], 0, doc)
        self.assertEqual(code, 10)
        self.assertEqual(doc["verdict"], "explained")
        return doc

    def test_every_rule_has_a_case_here(self):
        # the cases below, by rule id; adding a rule to RULES without a case fails this
        self.assertEqual(sorted(rules.RULES), sorted(["excluded-place", "media-held-mime", "birth-date-scrub",
                                                      "place-coordinates-rounded", "place-code-local", "note-newly-visible",
                                                      "text-gate-withheld", "tree-svg-frozen", "merged-person-stub",
                                                      "media-held-binary", "held-object", "media-location-stripped",
                                                      "media-baseline-unhydrated"]))

    def test_excluded_place(self):
        legacy, shadow = build_site(), build_site()
        city = load(legacy, PLACE_CITY)
        del shadow[PLACE_STREET]      # the street-level place has no file
        del shadow[PLACE_HOME]        # the custom home-like place neither
        edit(shadow, "place/index.json",
             lambda d: d.__setitem__(slice(None), [e for e in d if e["grampsId"] not in ("P9002", "P9003")]))
        edit(shadow, EVENT_MOVE, lambda d: d.update(place=brief(city)))                    # re-pointed to the kept ancestor
        edit(shadow, PERSON1, lambda d: d["events"][1].update(place=brief(city)))
        edit(shadow, PLACE_HILL, lambda d: d.update(parents=[brief(city)]))               # an excluded parent leaves the chain
        doc = self.explained(legacy, shadow)
        row = doc["rules"]["excluded-place"]
        self.assertEqual((row["only_in_legacy"], row["changed"], row["only_in_render"]), (2, 4, 0))
        self.assertEqual(row["areas"], {"person": 1, "event": 1, "place": 3, "index": 1})
        self.assertEqual(list(doc["rules"]), ["excluded-place"])

    def test_a_kept_place_is_not_excluded_by_its_custom_type(self):
        legacy, shadow = build_site(), build_site()
        del shadow[PLACE_HILL]        # 'Landmark' is a custom type that matches no home-like word
        edit(shadow, "place/index.json", lambda d: d.__setitem__(slice(None), [e for e in d if e["grampsId"] != "P9004"]))
        code, doc = report(legacy, shadow)
        self.assertEqual(code, 20)
        self.assertEqual(doc["classes"]["only_in_legacy"]["unexplained"], 1)

    def test_an_event_whose_place_is_excluded_and_has_no_ancestor(self):
        legacy, shadow = build_site(), build_site()
        edit(legacy, EVENT_MOVE, lambda d: d.update(place=brief(load(legacy, PLACE_HOME))))
        edit(shadow, EVENT_MOVE, lambda d: d.update(place=None))
        del shadow[PLACE_HOME]
        edit(shadow, "place/index.json", lambda d: d.__setitem__(slice(None), [e for e in d if e["grampsId"] != "P9003"]))
        doc = self.explained(legacy, shadow)
        self.assertEqual(doc["rules"]["excluded-place"]["changed"], 2)

    def test_media_held_mime(self):
        legacy, shadow = build_site(), build_site()
        edit(legacy, MEDIA_SCAN, lambda d: d.update(mime="application/pdf"))
        del shadow[MEDIA_SCAN]
        edit(shadow, "media/index.json", lambda d: d.__setitem__(slice(None), [e for e in d if e["grampsId"] != "O9002"]))
        put(legacy, "media/index.json", load(legacy, "media/index.json"))
        doc = self.explained(legacy, shadow)
        row = doc["rules"]["media-held-mime"]
        self.assertEqual((row["only_in_legacy"], row["changed"]), (1, 1))

    def test_a_missing_jpeg_media_file_is_not_a_hold(self):
        legacy, shadow = build_site(), build_site()
        del shadow[MEDIA_PHOTO]
        code, doc = report(legacy, shadow)
        self.assertEqual(code, 20)
        self.assertEqual(doc["unexplained_by_area"], {"media": 1})

    def test_birth_date_scrub(self):
        legacy, shadow = build_site(), build_site()
        for site, text in ((legacy, "12 March 1950"), (shadow, "1950")):
            edit(site, EVENT_BIRTH, lambda d: d["date"].update(text=text))
            edit(site, PERSON1, lambda d: d["events"][0]["date"].update(text=text))
        doc = self.explained(legacy, shadow)
        self.assertEqual(doc["rules"]["birth-date-scrub"]["changed"], 2)
        # a birth-like custom type counts too; an empty text is a scrub
        edit(legacy, EVENT_BIRTH, lambda d: d.update(type={"code": 0, "string": "Naissance"}))
        edit(shadow, EVENT_BIRTH, lambda d: (d.update(type={"code": 0, "string": "Naissance"}), d["date"].update(text="")))
        self.assertEqual(report(legacy, shadow)[0], 10)

    def test_a_day_on_a_non_birth_event_is_not_scrubbed(self):
        legacy, shadow = build_site(), build_site()
        edit(legacy, EVENT_MOVE, lambda d: d["date"].update(text="5 May 1960"))
        code, doc = report(legacy, shadow)
        self.assertEqual(code, 20)
        self.assertEqual(doc["unexplained_by_field"], {"text": 1})

    def test_place_coordinates_rounded(self):
        legacy, shadow = build_site(), build_site()
        edit(legacy, PLACE_CITY, lambda d: d.update(latitude="47.60621", longitude=-122.33207))
        edit(shadow, PLACE_CITY, lambda d: d.update(latitude="47.61", longitude=-122.33))
        edit(legacy, PERSON1, lambda d: d["events"][0]["place"].update(latitude="47.60621", longitude=-1.005))
        edit(shadow, PERSON1, lambda d: d["events"][0]["place"].update(latitude="47.61", longitude=-1.01))   # half away from zero
        doc = self.explained(legacy, shadow)
        self.assertEqual(doc["rules"]["place-coordinates-rounded"]["changed"], 2)

    def test_a_coordinate_that_is_not_plain_is_blanked_and_a_wrong_rounding_is_not_explained(self):
        legacy, shadow = build_site(), build_site()
        edit(legacy, PLACE_CITY, lambda d: d.update(latitude="47 degrees north"))
        edit(shadow, PLACE_CITY, lambda d: d.update(latitude=None))
        self.assertEqual(report(legacy, shadow)[0], 10)
        edit(legacy, PLACE_CITY, lambda d: d.update(latitude="47.60621"))
        edit(shadow, PLACE_CITY, lambda d: d.update(latitude="47.60"))
        code, doc = report(legacy, shadow)
        self.assertEqual((code, doc["unexplained_by_field"]), (20, {"latitude": 1}))

    def test_place_code_local(self):
        legacy, shadow = build_site(), build_site()
        edit(legacy, PLACE_CITY, lambda d: d.update(code="99999"))     # a postal code on a City
        doc = self.explained(legacy, shadow)
        self.assertEqual(doc["rules"]["place-code-local"]["changed"], 1)
        # a State keeps its code, so a blank one is not explained
        edit(legacy, PLACE_CITY, lambda d: d.update(type={"code": 2, "string": "State"}))
        edit(shadow, PLACE_CITY, lambda d: d.update(type={"code": 2, "string": "State"}))
        code, doc = report(legacy, shadow)
        self.assertEqual((code, doc["unexplained_by_field"]), (20, {"code": 1}))

    def test_note_newly_visible(self):
        legacy, shadow = build_site(), build_site()
        edit(shadow, NOTE, lambda d: d.update(raw="Test note text", html="<p>Test note text</p>"))
        edit(shadow, PERSON1, lambda d: d["notes"][0].update(raw="Test note text", html="<p>Test note text</p>"))
        doc = self.explained(legacy, shadow)
        row = doc["rules"]["note-newly-visible"]
        self.assertEqual((row["changed"], row["areas"]), (2, {"person": 1, "note": 1}))

    def test_text_gate_withheld(self):
        legacy, shadow = build_site(), build_site()
        edit(legacy, NOTE, lambda d: d.update(raw="Test note text", html="<p>Test note text</p>"))
        edit(legacy, EVENT_BIRTH, lambda d: d.update(description="Test description"))
        edit(legacy, MEDIA_PHOTO, lambda d: d.update(title="Test Photo Title"))
        edit(shadow, MEDIA_PHOTO, lambda d: d.update(title="O9001"))                   # the title falls back to the Gramps ID
        edit(legacy, PLACE_CITY, lambda d: d.update(urls=[{"path": "https://example.test/a"}, {"path": "mailto:x@example.test"}]))
        edit(shadow, PLACE_CITY, lambda d: d.update(urls=[{"path": "https://example.test/a"}]))
        for site in (legacy, shadow):
            edit(site, PERSON1, lambda d: d.update(mediaGallery=[{"grampsId": "O9001", "mime": "image/jpeg", "tags": [
                {"citations": ["Test Title A", "Test Title B"] if site is legacy else ["Test Title A"]}]}]))
        doc = self.explained(legacy, shadow)
        self.assertEqual(list(doc["rules"]), ["text-gate-withheld"])
        self.assertEqual(doc["rules"]["text-gate-withheld"]["changed"], 5)

    def test_a_changed_title_that_is_not_the_id_fallback_is_unexplained(self):
        legacy, shadow = build_site(), build_site()
        edit(shadow, MEDIA_PHOTO, lambda d: d.update(title="Another Title"))
        code, doc = report(legacy, shadow)
        self.assertEqual((code, doc["unexplained_by_field"]), (20, {"title": 1}))

    def test_tree_svg_frozen(self):
        legacy, shadow = build_site(), build_site()
        edit(legacy, PERSON1, lambda d: d.update(familyTreeMedia={"s3Key": "media/tree_I9001.svg"}))
        doc = self.explained(legacy, shadow)
        self.assertEqual(doc["rules"]["tree-svg-frozen"]["areas"], {"person": 1})

    def test_merged_person_stub(self):
        legacy, shadow = build_site(), build_site()
        shadow["person/I9003.json"] = dumps({"mergedInto": "I9001"})
        doc = self.explained(legacy, shadow)
        self.assertEqual(doc["rules"]["merged-person-stub"]["only_in_render"], 1)
        shadow["person/I9004.json"] = dumps({"mergedInto": "I9001", "displayName": "Test Person Four"})
        self.assertEqual(report(legacy, shadow)[0], 20)


# ---- HFY-TSK-372: bare-year scrub, held binaries and held objects --------------------------------------------------------

PHOTO_FIELDS = ("checksum", "grampsId", "handle", "missing", "s3Key", "size")


def with_photo_users(site):
    """Person one shows photo O9001 as primaryPhoto and in mediaGallery[]; media/index.json carries the same fields."""
    media = load(site, MEDIA_PHOTO)
    entry = {k: media[k] for k in PHOTO_FIELDS}

    def index(doc):
        doc[:] = [dict(entry) if e["grampsId"] == "O9001" else e for e in doc]
    edit(site, PERSON1, lambda d: d.update(primaryPhoto=dict(entry), mediaGallery=[dict(entry)]))
    edit(site, "media/index.json", index)


def hold_photo_binary(site, **overrides):
    """The shadow side of a held binary: missing=true, null checksum and size, on the media file, the index entry and both
    person fields. ``overrides`` replace a field on all four places (the near misses)."""
    held = dict(missing=True, checksum=None, size=None)
    held.update(overrides)

    def index(doc):
        for e in doc:
            if e["grampsId"] == "O9001":
                e.update(held)
    edit(site, MEDIA_PHOTO, lambda d: d.update(held))
    edit(site, PERSON1, lambda d: (d["primaryPhoto"].update(held), d["mediaGallery"][0].update(held)))
    edit(site, "media/index.json", index)


def pair_with_held_photo(**overrides):
    legacy, shadow = build_site(), build_site()
    with_photo_users(legacy)
    with_photo_users(shadow)
    hold_photo_binary(shadow, **overrides)
    return legacy, shadow


def add_held_object(legacy, kind, n):
    """A whole object only the legacy side has (the add-on held it back), with its index entry. Returns its site key."""
    gid = {"person": "I", "family": "F", "event": "E", "note": "N", "place": "P", "media": "O"}[kind] + str(9100 + n)
    if kind == "person":
        key = "person/%s.json" % gid
        put(legacy, key, {"handle": hid(gid), "grampsId": gid, "displayName": "Test Held Person %d" % n, "events": [],
                          "notes": [], "mediaGallery": []})
        edit(legacy, "person/index.json", lambda d: (d["people"].append({"handle": hid(gid), "grampsId": gid, "displayName": "Test Held Person"}),
                                                     d.update(count=len(d["people"]))))
        edit(legacy, "person/search-index.json", lambda d: d["documents"].append({"grampsId": gid, "searchText": "test held person"}))
        return key
    key = "%s/%s.json" % (kind, hid(gid))
    if kind == "family":
        put(legacy, key, {"grampsId": gid, "handle": hid(gid), "children": []})
    elif kind == "event":
        put(legacy, key, event_doc(gid, "Residence", 33, "Residence", "1970", 1970))
    elif kind == "note":
        put(legacy, key, note_doc(gid, "", ""))
    elif kind == "place":
        put(legacy, key, place_doc(gid, "Heldtown", 4, "City"))
        edit(legacy, "place/index.json", lambda d: d.append({"displayName": "Heldtown", "grampsId": gid, "handle": hid(gid)}))
    else:
        media = media_doc(gid, "image/jpeg", "jpg", "Test Held Photo")
        put(legacy, key, media)
        edit(legacy, "media/index.json", lambda d: d.append({"grampsId": gid, "handle": hid(gid), "s3Key": media["s3Key"], "size": 12}))
    return key


def pair_with_holds(kinds):
    legacy, shadow = build_site(), build_site()
    keys = [add_held_object(legacy, kind, n) for n, kind in enumerate(kinds)]
    return legacy, shadow, keys


def report_with(legacy, shadow, *extra):
    code, cap = run_cli(legacy, shadow, ["--json"] + list(extra))
    return code, json.loads(cap.out.getvalue())


class BirthDateScrubOfABareYear(unittest.TestCase):
    def blank_text(self, site, text="", year=None):
        def fn(date):
            date.update(text=text)
            if year is not None:
                date.update(year=year)
        edit(site, EVENT_BIRTH, lambda d: fn(d["date"]))
        edit(site, PERSON1, lambda d: fn(d["events"][0]["date"]))

    def test_a_bare_year_blanked_with_the_year_kept_is_a_scrub_on_the_event_and_the_person_entry(self):
        legacy, shadow = build_site(), build_site()
        self.assertEqual(load(legacy, EVENT_BIRTH)["date"], {"text": "1950", "year": 1950})
        self.blank_text(shadow)
        code, doc = report(legacy, shadow)
        self.assertEqual((code, doc["unexplained"]), (10, 0))
        row = doc["rules"]["birth-date-scrub"]
        self.assertEqual((row["changed"], row["areas"]), (2, {"person": 1, "event": 1}))
        self.assertEqual(list(doc["rules"]), ["birth-date-scrub"])

    def test_any_other_non_empty_text_blanked_with_the_year_kept_is_a_scrub_too(self):
        for text in ("about 1950", "12 March 1950", "1950-03-12"):
            legacy, shadow = build_site(), build_site()
            self.blank_text(legacy, text)
            self.blank_text(shadow)
            code, doc = report(legacy, shadow)
            self.assertEqual((code, doc["unexplained"]), (10, 0), text)

    def test_the_year_changing_as_well_is_not_a_scrub(self):
        legacy, shadow = build_site(), build_site()
        self.blank_text(shadow, "", year=1951)
        code, doc = report(legacy, shadow)
        self.assertEqual(code, 20)
        self.assertEqual(doc["unexplained_by_field"], {"text": 2, "year": 2})
        self.assertNotIn("birth-date-scrub", doc["rules"])

    def test_the_year_dropped_from_the_event_is_not_a_scrub(self):
        legacy, shadow = build_site(), build_site()
        edit(shadow, EVENT_BIRTH, lambda d: (d["date"].update(text=""), d["date"].pop("year")))
        code, doc = report(legacy, shadow)
        self.assertEqual((code, doc["unexplained_by_field"]), (20, {"text": 1, "year": 1}))

    def test_a_non_birth_event_keeps_its_text(self):
        legacy, shadow = build_site(), build_site()
        edit(shadow, EVENT_MOVE, lambda d: d["date"].update(text=""))
        code, doc = report(legacy, shadow)
        self.assertEqual((code, doc["unexplained_by_field"]), (20, {"text": 1}))

    def test_a_blank_that_becomes_another_text_is_not_a_scrub(self):
        legacy, shadow = build_site(), build_site()
        edit(shadow, EVENT_BIRTH, lambda d: d["date"].update(text="1951"))          # a bare year, but not the legacy one
        edit(legacy, PERSON1, lambda d: d["events"][0]["date"].update(text="12 March 1950"))
        edit(shadow, PERSON1, lambda d: d["events"][0]["date"].update(text="1951"))
        code, doc = report(legacy, shadow)
        self.assertEqual((code, doc["unexplained_by_field"]), (20, {"text": 2}))


class MediaHeldBinary(unittest.TestCase):
    def test_the_whole_pattern_is_explained_on_the_file_the_index_and_the_person_fields(self):
        legacy, shadow = pair_with_held_photo()
        code, doc = report(legacy, shadow)
        self.assertEqual((code, doc["unexplained"]), (10, 0))
        row = doc["rules"]["media-held-binary"]
        self.assertEqual((row["changed"], row["only_in_legacy"], row["only_in_render"]), (3, 0, 0))
        self.assertEqual(row["areas"], {"person": 1, "media": 1, "index": 1})
        self.assertEqual(list(doc["rules"]), ["media-held-binary"])

    def test_each_place_alone_is_explained(self):
        for place in ("media", "person", "index"):
            legacy, shadow = pair_with_held_photo()
            full = copy.deepcopy(legacy)
            # only one place carries the held pattern; the other two stay as the legacy export had them
            held = copy.deepcopy(shadow)
            shadow = copy.deepcopy(legacy)
            if place == "media":
                shadow[MEDIA_PHOTO] = held[MEDIA_PHOTO]
            elif place == "person":
                shadow[PERSON1] = held[PERSON1]
            else:
                shadow["media/index.json"] = held["media/index.json"]
            code, doc = report(full, shadow)
            self.assertEqual((code, doc["unexplained"]), (10, 0), place)
            self.assertEqual(doc["rules"]["media-held-binary"]["changed"], 1, place)

    def test_only_the_checksum_differing_while_missing_is_false_is_not_explained(self):
        legacy, shadow = pair_with_held_photo(missing=False, size=12)
        code, doc = report(legacy, shadow)
        self.assertEqual(code, 20)
        self.assertEqual(set(doc["unexplained_by_field"]), {"checksum"})
        self.assertEqual(doc["unexplained_by_area"], {"media": 1, "person": 1, "index": 1})
        self.assertNotIn("media-held-binary", doc["rules"])

    def test_a_size_that_is_not_null_is_not_explained(self):
        legacy, shadow = pair_with_held_photo(size=12)
        code, doc = report(legacy, shadow)
        self.assertEqual(code, 20)
        self.assertEqual(set(doc["unexplained_by_field"]), {"missing", "checksum"})
        self.assertNotIn("media-held-binary", doc["rules"])

    def test_a_checksum_that_is_another_string_is_not_explained(self):
        legacy, shadow = pair_with_held_photo(checksum="f" * 64)
        code, doc = report(legacy, shadow)
        self.assertEqual(code, 20)
        self.assertEqual(set(doc["unexplained_by_field"]), {"missing", "checksum", "size"})

    def test_a_legacy_entry_without_a_checksum_is_not_explained(self):
        legacy, shadow = pair_with_held_photo()
        for key in (MEDIA_PHOTO,):
            edit(legacy, key, lambda d: d.update(checksum=None))
        code, doc = report(legacy, shadow)
        self.assertEqual(code, 20)
        self.assertEqual(set(doc["unexplained_by_field"]), {"missing", "size"})
        self.assertEqual(doc["unexplained_by_area"], {"media": 1})
        self.assertEqual(doc["rules"]["media-held-binary"]["areas"], {"person": 1, "index": 1})

    def test_another_field_that_differs_stays_unexplained(self):
        legacy, shadow = pair_with_held_photo()
        edit(shadow, MEDIA_PHOTO, lambda d: d.update(mime="image/png"))
        code, doc = report(legacy, shadow)
        self.assertEqual((code, doc["unexplained_by_field"]), (20, {"mime": 1}))
        self.assertEqual(doc["unexplained_by_area"], {"media": 1})
        self.assertEqual(doc["rules"]["media-held-binary"]["areas"], {"person": 1, "index": 1})

    def test_another_handle_is_not_the_same_media(self):
        legacy, shadow = pair_with_held_photo()
        edit(shadow, PERSON1, lambda d: d["mediaGallery"][0].update(handle=hid("O9999")))
        code, doc = report(legacy, shadow)
        self.assertEqual(code, 20)
        self.assertEqual(set(doc["unexplained_by_field"]), {"handle", "missing", "checksum", "size"})

    def test_the_pattern_on_a_file_that_is_not_a_media_object_is_not_explained(self):
        legacy, shadow = build_site(), build_site()
        edit(legacy, PLACE_CITY, lambda d: d.update(checksum="a" * 32, missing=False, size=3))
        edit(shadow, PLACE_CITY, lambda d: d.update(checksum=None, missing=True, size=None))
        code, doc = report(legacy, shadow)
        self.assertEqual((code, doc["unexplained_by_area"]), (20, {"place": 1}))
        self.assertNotIn("media-held-binary", doc["rules"])


STRIPPED_CHECKSUM = "c" * 64


def strip_photo(site, key=MEDIA_PHOTO, grampsid="O9001", checksum=STRIPPED_CHECKSUM, size=None, **overrides):
    """The shadow side of a photo sent without its location: another checksum (and, when ``size`` is given, another size) on the media file,
    the index entry and both person fields."""
    new = dict(checksum=checksum)
    if size is not None:
        new["size"] = size
    new.update(overrides)

    def index(doc):
        for e in doc:
            if e["grampsId"] == grampsid:
                e.update(new)
    edit(site, key, lambda d: d.update(new))
    if key == MEDIA_PHOTO:
        edit(site, PERSON1, lambda d: (d["primaryPhoto"].update(new), d["mediaGallery"][0].update(new)))
    edit(site, "media/index.json", index)


def pair_with_stripped_photo(**kw):
    legacy, shadow = build_site(), build_site()
    with_photo_users(legacy)
    with_photo_users(shadow)
    strip_photo(shadow, **kw)
    return legacy, shadow


class MediaLocationStripped(unittest.TestCase):
    """HFY-TSK-374: a photo sent as a copy without its GPS location has another checksum on the website; explained only up to --expect-stripped."""

    def test_the_file_the_index_entry_and_the_person_fields_are_explained_up_to_the_count(self):
        for size in (None, 1234):                 # the copy is as long as the original, or shorter
            legacy, shadow = pair_with_stripped_photo(size=size)
            code, doc = report_with(legacy, shadow, "--expect-stripped", "1")
            self.assertEqual((code, doc["unexplained"], doc["verdict"]), (10, 0, "explained"), size)
            row = doc["rules"]["media-location-stripped"]
            self.assertEqual((row["changed"], row["only_in_legacy"], row["only_in_render"]), (3, 0, 0))
            self.assertEqual(row["areas"], {"person": 1, "media": 1, "index": 1})
            self.assertEqual(list(doc["rules"]), ["media-location-stripped"])
            self.assertEqual(doc["stripped"], {"allowed": 1, "explained": 1})

    def test_without_the_option_nothing_changes(self):
        legacy, shadow = pair_with_stripped_photo()
        code, doc = report_with(legacy, shadow)
        self.assertEqual((code, doc["verdict"]), (20, "unexplained"))
        self.assertNotIn("stripped", doc)
        self.assertNotIn("media-location-stripped", doc["rules"])
        self.assertEqual(set(doc["unexplained_by_field"]), {"checksum"})

    def test_more_media_than_the_count_stay_unexplained(self):
        legacy, shadow = pair_with_stripped_photo()
        other = sorted(k for k in shadow if k.startswith("media/") and k.endswith(".json") and k not in (MEDIA_PHOTO, "media/index.json")
                       and isinstance(load(shadow, k).get("checksum"), str) and load(shadow, k).get("checksum"))[0]
        edit(shadow, other, lambda d: d.update(checksum="d" * 64))
        code, doc = report_with(legacy, shadow, "--expect-stripped", "1")
        self.assertEqual(code, 20)
        self.assertEqual(doc["stripped"], {"allowed": 1, "explained": 1})
        self.assertIn(doc["rules"]["media-location-stripped"]["changed"], (2, 3), "the first handle in sorted order is the one explained")
        self.assertEqual(set(doc["unexplained_by_field"]), {"checksum"})
        code, doc = report_with(legacy, shadow, "--expect-stripped", "2")
        self.assertEqual((code, doc["stripped"]), (10, {"allowed": 2, "explained": 2}))
        code, doc = report_with(legacy, shadow, "--expect-stripped", "0")
        self.assertEqual((code, doc["stripped"]), (20, {"allowed": 0, "explained": 0}))

    def test_the_pattern_needs_a_checksum_and_a_size_on_both_sides_that_differ(self):
        for label, legacy_edit, shadow_edit in (
                ("no legacy checksum", {"checksum": None}, {}),
                ("no shadow checksum", {}, {"checksum": None}),
                ("no legacy size", {"size": None}, {}),
                ("no shadow size", {}, {"size": None}),
                ("a missing shadow", {}, {"missing": True}),
                ("the same checksum", {}, {"checksum": "REPLACED"})):
            legacy, shadow = pair_with_stripped_photo()
            edit(legacy, MEDIA_PHOTO, lambda d: d.update(legacy_edit))
            if shadow_edit.get("checksum") == "REPLACED":
                shadow_edit = {"checksum": load(legacy, MEDIA_PHOTO)["checksum"]}
            edit(shadow, MEDIA_PHOTO, lambda d: d.update(shadow_edit))
            code, doc = report_with(legacy, shadow, "--expect-stripped", "5")
            self.assertEqual(doc["stripped"]["explained"] if "stripped" in doc else None, 0 if label != "the same checksum" else 0, label)
            self.assertEqual(code, 20, label)

    def test_a_size_that_changed_alone_or_another_field_is_not_explained(self):
        legacy, shadow = build_site(), build_site()
        with_photo_users(legacy)
        with_photo_users(shadow)
        edit(shadow, MEDIA_PHOTO, lambda d: d.update(size=load(shadow, MEDIA_PHOTO)["size"] + 1))
        code, doc = report_with(legacy, shadow, "--expect-stripped", "5")
        self.assertEqual((code, set(doc["unexplained_by_field"])), (20, {"size"}))
        legacy, shadow = pair_with_stripped_photo()
        edit(shadow, MEDIA_PHOTO, lambda d: d.update(mime="image/png"))
        code, doc = report_with(legacy, shadow, "--expect-stripped", "5")
        self.assertEqual((code, set(doc["unexplained_by_field"])), (20, {"mime"}))

    def test_a_held_binary_keeps_its_own_rule(self):
        legacy, shadow = pair_with_held_photo()
        code, doc = report_with(legacy, shadow, "--expect-stripped", "5")
        self.assertEqual((code, list(doc["rules"]), doc["stripped"]), (10, ["media-held-binary"], {"allowed": 5, "explained": 0}))

    def test_a_bad_count_is_a_usage_error_that_never_echoes_it(self):
        legacy, shadow = pair_with_stripped_photo()
        for bad in ("-1", "abc", "1.5", " 1", "1 ", "\u0663", "secret-count-7", ""):
            code, cap = run_cli(legacy, shadow, ["--expect-stripped", bad])
            self.assertEqual(code, 64, repr(bad))
        code, cap = run_cli(legacy, shadow, ["--expect-stripped", "secret-count-7"])
        self.assertNotIn("secret-count-7", cap.out.getvalue() + cap.err.getvalue())

    def sidecar_with(self, handles, dropped=None):
        import sqlite3
        import tempfile
        folder = tempfile.mkdtemp(prefix="hfy-parity-sidecar-")
        self.addCleanup(shutil.rmtree, folder, True)
        path = os.path.join(folder, "state.sqlite")
        con = sqlite3.connect(path)
        con.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        if handles is not None:
            con.execute("INSERT INTO meta VALUES ('media_location_stripped', ?)", (json.dumps({h: ["a" * 64, "b" * 64, "c" * 32] for h in handles}),))
        con.commit()
        con.close()
        return path

    def test_the_sidecar_limits_the_explained_media_to_the_ones_it_recorded(self):
        legacy, shadow = pair_with_stripped_photo()
        handle = load(legacy, MEDIA_PHOTO)["handle"]
        code, doc = report_with(legacy, shadow, "--expect-stripped", "5", "--stripped-sidecar", self.sidecar_with([handle]))
        self.assertEqual((code, doc["stripped"]), (10, {"allowed": 5, "explained": 1}))
        code, doc = report_with(legacy, shadow, "--expect-stripped", "5", "--stripped-sidecar", self.sidecar_with(["someOtherHandle"]))
        self.assertEqual((code, doc["stripped"], set(doc["unexplained_by_field"])), (20, {"allowed": 5, "explained": 0}, {"checksum"}),
                         "a media that differs but was never recorded as stripped is not explained, whatever the count says")
        code, doc = report_with(legacy, shadow, "--expect-stripped", "5", "--stripped-sidecar", self.sidecar_with(None))
        self.assertEqual((code, doc["stripped"]["explained"]), (20, 0), "a sidecar that recorded none explains none")

    def test_a_hostile_sidecar_is_a_usage_error_not_a_traceback(self):
        import sqlite3
        legacy, shadow = pair_with_stripped_photo()
        folder = tempfile.mkdtemp(prefix="hfy-parity-hostile-")
        self.addCleanup(shutil.rmtree, folder, True)
        for name, value in (("nested", "[" * 200000 + "]" * 200000), ("deep-object", '{"a":' * 100000 + "1" + "}" * 100000), ("blob", b"\x00\x01"), ("int", 5)):
            path = os.path.join(folder, name + ".sqlite")
            con = sqlite3.connect(path)
            con.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value)")
            con.execute("INSERT INTO meta VALUES ('media_location_stripped', ?)", (value,))
            con.commit()
            con.close()
            code, cap = run_cli(legacy, shadow, ["--expect-stripped", "1", "--stripped-sidecar", path])
            self.assertEqual(code, 64, name)
            self.assertNotIn("Traceback", cap.out.getvalue() + cap.err.getvalue())

    def test_a_bad_sidecar_or_one_without_the_count_is_a_usage_error_that_prints_no_path(self):
        legacy, shadow = pair_with_stripped_photo()
        for extra in (["--expect-stripped", "1", "--stripped-sidecar", "/nonexistent/secret-folder/state.sqlite"],
                      ["--stripped-sidecar", self.sidecar_with([])]):
            code, cap = run_cli(legacy, shadow, extra)
            self.assertEqual(code, 64)
            self.assertNotIn("secret-folder", cap.out.getvalue() + cap.err.getvalue())
            self.assertNotIn("state.sqlite", cap.out.getvalue() + cap.err.getvalue())

    def test_the_text_report_shows_the_rule_and_the_allowance(self):
        legacy, shadow = pair_with_stripped_photo()
        code, cap = run_cli(legacy, shadow, ["--expect-stripped", "1"])
        text = cap.out.getvalue()
        self.assertEqual(code, 10)
        self.assertIn("media-location-stripped", text)
        self.assertIn("media sent without their location: allowed 1, media explained 1", text)
        self.assertNotIn(hid("O9001"), text)


# ---- HFY-TSK-376: a legacy record captured while the file was online-only ---------------------------------------------------

EMPTY_HASH = hashlib.sha256(b"").hexdigest()
REAL_HASH = "ab12" * 16
UNHYDRATED = {"empty": dict(checksum=EMPTY_HASH, size=0, missing=False), "null": dict(checksum=None, size=None, missing=True)}
HYDRATED = dict(checksum=REAL_HASH, size=2048, missing=False)
SCAN_PERSON = "person/I9002.json"


def with_users(site):
    """Person one shows O9001 as primaryPhoto and in mediaGallery[], person two shows O9002 the same way, and media/index.json carries
    the same fields for both."""
    entries = {}
    for gid, key in (("O9001", MEDIA_PHOTO), ("O9002", MEDIA_SCAN)):
        media = load(site, key)
        entries[gid] = {k: media[k] for k in PHOTO_FIELDS}

    def index(doc):
        doc[:] = [dict(entries[e["grampsId"]]) if e["grampsId"] in entries else e for e in doc]
    edit(site, "media/index.json", index)
    for key, gid in ((PERSON1, "O9001"), (SCAN_PERSON, "O9002")):
        edit(site, key, lambda d: d.update(primaryPhoto=dict(entries[gid]), mediaGallery=[dict(entries[gid])]))


def set_media(site, gid, fields, places=("media", "index", "person")):
    """Set ``fields`` on the media file, its index entry and the person fields of O9001 or O9002 (``places`` limits where)."""
    key, person = (MEDIA_PHOTO, PERSON1) if gid == "O9001" else (MEDIA_SCAN, SCAN_PERSON)
    if "media" in places:
        edit(site, key, lambda d: d.update(fields))
    if "index" in places:
        edit(site, "media/index.json", lambda d: [e.update(fields) for e in d if e["grampsId"] == gid])
    if "person" in places:
        edit(site, person, lambda d: (d["primaryPhoto"].update(fields), d["mediaGallery"][0].update(fields)))


def pair_with_unhydrated(variants=("empty",), shadow_fields=None, legacy_fields=None):
    """Legacy: the first media (O9001, then O9002) are unhydrated captures of the given variants. Shadow: the real checksum and size."""
    legacy, shadow = build_site(), build_site()
    with_users(legacy)
    with_users(shadow)
    for gid, variant in zip(("O9001", "O9002"), variants):
        set_media(legacy, gid, dict(UNHYDRATED[variant], **(legacy_fields or {})))
        set_media(shadow, gid, dict(HYDRATED, **(shadow_fields or {})))
    return legacy, shadow


OPT = "--expect-baseline-unhydrated"
RULE = "media-baseline-unhydrated"


class MediaBaselineUnhydrated(unittest.TestCase):
    """HFY-TSK-376: the legacy export was taken while a photo was a Dropbox online-only placeholder. Explained only up to the count."""

    def test_the_empty_hash_is_the_sha256_of_the_empty_file(self):
        self.assertEqual(compare_mod.EMPTY_SHA256, hashlib.sha256(b"").hexdigest())

    def test_each_variant_is_explained_on_the_file_the_index_entry_and_the_person_fields(self):
        for variant in ("empty", "null"):
            legacy, shadow = pair_with_unhydrated((variant,))
            code, doc = report_with(legacy, shadow, OPT, "1")
            self.assertEqual((code, doc["unexplained"], doc["verdict"]), (10, 0, "explained"), variant)
            row = doc["rules"][RULE]
            self.assertEqual((row["changed"], row["only_in_legacy"], row["only_in_render"]), (3, 0, 0), variant)
            self.assertEqual(row["areas"], {"person": 1, "media": 1, "index": 1}, variant)
            self.assertEqual(list(doc["rules"]), [RULE], variant)
            self.assertEqual(doc["baseline_unhydrated"], {"allowed": 1, "explained": 1}, variant)
            self.assertNotIn("stripped", doc)
            self.assertNotIn("holds", doc)

    def test_both_variants_at_once_with_a_count_of_two(self):
        legacy, shadow = pair_with_unhydrated(("empty", "null"))
        code, doc = report_with(legacy, shadow, OPT, "2")
        self.assertEqual((code, doc["unexplained"]), (10, 0))
        row = doc["rules"][RULE]
        self.assertEqual((row["changed"], row["areas"]), (5, {"person": 2, "media": 2, "index": 1}))
        self.assertEqual(doc["baseline_unhydrated"], {"allowed": 2, "explained": 2})
        code, doc = report_with(legacy, shadow, OPT, "9")
        self.assertEqual((code, doc["baseline_unhydrated"]), (10, {"allowed": 9, "explained": 2}), "an allowance above the need is only an allowance")

    def test_without_the_option_nothing_is_explained(self):
        for variant, fields in (("empty", {"checksum", "size"}), ("null", {"checksum", "size", "missing"})):
            legacy, shadow = pair_with_unhydrated((variant,))
            code, doc = report_with(legacy, shadow)
            self.assertEqual((code, doc["verdict"]), (20, "unexplained"), variant)
            self.assertNotIn("baseline_unhydrated", doc)
            self.assertNotIn(RULE, doc["rules"])
            self.assertEqual(set(doc["unexplained_by_field"]), fields, variant)
            self.assertEqual(doc["unexplained_by_area"], {"media": 1, "person": 1, "index": 1}, variant)

    def test_more_media_than_the_count_stay_unexplained(self):
        legacy, shadow = pair_with_unhydrated(("empty", "null"))
        first = sorted([MEDIA_PHOTO, MEDIA_SCAN])[0]
        code, doc = report_with(legacy, shadow, OPT, "1")
        self.assertEqual(code, 20)
        self.assertEqual(doc["baseline_unhydrated"], {"allowed": 1, "explained": 1})
        self.assertEqual(doc["rules"][RULE]["areas"], {"media": 1, "person": 1}, "the index file still holds an unexplained entry")
        self.assertEqual(doc["unexplained_by_area"], {"media": 1, "person": 1, "index": 1})
        again = report_with(legacy, shadow, OPT, "1")
        self.assertEqual(again, (code, doc), "the same media are taken every time")
        # the media taken is the first handle in sorted key order: the other one is the unexplained one
        self.assertIn("checksum", doc["unexplained_by_field"])
        self.assertEqual("missing" in doc["unexplained_by_field"], first == MEDIA_PHOTO, "only the null capture (O9002) differs in missing")
        code, doc = report_with(legacy, shadow, OPT, "0")
        self.assertEqual((code, doc["baseline_unhydrated"]), (20, {"allowed": 0, "explained": 0}))
        self.assertNotIn(RULE, doc["rules"])

    def test_a_legacy_side_that_is_not_an_unhydrated_capture_is_not_explained(self):
        for label, legacy_fields in (
                ("a real different checksum", dict(checksum="c" * 64, size=12, missing=False)),
                ("the empty hash with a size", dict(checksum=EMPTY_HASH, size=12, missing=False)),
                ("the empty hash and size 0 but missing", dict(checksum=EMPTY_HASH, size=0, missing=True)),
                ("the empty hash with a null size", dict(checksum=EMPTY_HASH, size=None, missing=False)),
                ("the empty hash with a size of 0.0", dict(checksum=EMPTY_HASH, size=0.0, missing=False)),
                ("the empty hash with a size of false", dict(checksum=EMPTY_HASH, size=False, missing=False)),
                ("the empty hash, size 0, missing null", dict(checksum=EMPTY_HASH, size=0, missing=None)),
                ("the empty hash upper-cased", dict(checksum=EMPTY_HASH.upper(), size=0, missing=False)),
                ("a null checksum with a size", dict(checksum=None, size=0, missing=True)),
                ("a null checksum and size, not missing", dict(checksum=None, size=None, missing=False)),
                ("a blank checksum, null size, missing", dict(checksum="", size=None, missing=True)),
                ("a checksum, null size, missing", dict(checksum="d" * 64, size=None, missing=True))):
            legacy, shadow = pair_with_unhydrated(("empty",), legacy_fields=None)
            set_media(legacy, "O9001", legacy_fields)
            code, doc = report_with(legacy, shadow, OPT, "5")
            self.assertEqual((code, doc["baseline_unhydrated"]["explained"]), (20, 0), label)
            self.assertNotIn(RULE, doc["rules"], label)
            self.assertEqual(doc["unexplained_by_area"], {"media": 1, "person": 1, "index": 1}, label)

    def test_a_shadow_side_that_is_not_hydrated_is_not_explained(self):
        for variant in ("empty", "null"):
            for label, shadow_fields in (
                    ("the shadow also holds the empty hash", dict(checksum=EMPTY_HASH)),
                    ("a shadow size of 0", dict(size=0)),
                    ("a negative shadow size", dict(size=-5)),
                    ("a shadow that is missing", dict(missing=True)),
                    ("a shadow missing flag that is null", dict(missing=None)),
                    ("a null shadow checksum", dict(checksum=None)),
                    ("a null shadow size", dict(size=None)),
                    ("a blank shadow checksum", dict(checksum="")),
                    ("a 63 digit checksum", dict(checksum="a" * 63)),
                    ("a 65 digit checksum", dict(checksum="a" * 65)),
                    ("a checksum that is not hex", dict(checksum="g" * 64)),
                    ("an upper-case checksum", dict(checksum="A" * 64)),
                    ("a checksum with a trailing newline", dict(checksum="a" * 64 + "\n")),
                    ("a size that is a float", dict(size=2048.0)),
                    ("a size that is true", dict(size=True)),
                    ("a size that is text", dict(size="2048"))):
                legacy, shadow = pair_with_unhydrated((variant,), shadow_fields=shadow_fields)
                code, doc = report_with(legacy, shadow, OPT, "5")
                self.assertEqual((code, doc["baseline_unhydrated"]["explained"]), (20, 0), (variant, label))
                self.assertNotIn(RULE, doc["rules"], (variant, label))

    def test_a_media_that_differs_in_another_field_is_not_explained(self):
        changes = (
            ("title", lambda d: d.update(title="Another Title")),
            ("title falling back to the Gramps id", lambda d: d.update(title="O9001")),
            ("s3Key", lambda d: d.update(s3Key="media/other.png")),
            ("mime", lambda d: d.update(mime="image/png")),
            ("grampsId", lambda d: d.update(grampsId="O9777")),
            ("regions", lambda d: d.update(regions=[{"rect": [1, 2, 3, 4]}])),
            ("an added field", lambda d: d.update(extra="x")),
            ("a removed field", lambda d: d.pop("regions")))
        for label, change in changes:
            legacy, shadow = pair_with_unhydrated(("empty",))
            edit(shadow, MEDIA_PHOTO, change)
            code, doc = report_with(legacy, shadow, OPT, "5")
            self.assertEqual((code, doc["baseline_unhydrated"]["explained"]), (20, 0), label)
            self.assertNotIn(RULE, doc["rules"], label)
            self.assertEqual(doc["unexplained_by_area"], {"media": 1, "person": 1, "index": 1},
                             label + ": the index entry and the person fields embed a media the rule did not take")
        legacy, shadow = pair_with_unhydrated(("null",))
        edit(shadow, MEDIA_PHOTO, lambda d: d.update(mime="image/png"))
        code, doc = report_with(legacy, shadow, OPT, "5")
        self.assertEqual((code, doc["baseline_unhydrated"]["explained"]), (20, 0))

    def test_another_handle_is_not_the_same_media(self):
        legacy, shadow = pair_with_unhydrated(("empty",))
        edit(shadow, MEDIA_PHOTO, lambda d: d.update(handle=hid("O9999")))
        code, doc = report_with(legacy, shadow, OPT, "5")
        self.assertEqual((code, doc["baseline_unhydrated"]["explained"]), (20, 0))
        self.assertIn("handle", doc["unexplained_by_field"])

    def test_an_embedded_entry_that_differs_in_another_field_is_not_explained(self):
        legacy, shadow = pair_with_unhydrated(("empty",))
        edit(shadow, PERSON1, lambda d: d["primaryPhoto"].update(s3Key="media/other.png"))
        code, doc = report_with(legacy, shadow, OPT, "1")
        self.assertEqual(code, 20)
        self.assertEqual(doc["baseline_unhydrated"], {"allowed": 1, "explained": 1})
        self.assertEqual(doc["unexplained_by_area"], {"person": 1})
        self.assertEqual(doc["unexplained_by_field"], {"s3Key": 1, "checksum": 1, "size": 1},
                         "the entry is not the pattern, so its checksum and size stay unexplained too; the gallery entry is the pattern")
        self.assertEqual(doc["rules"][RULE]["areas"], {"media": 1, "index": 1})
        # the gallery entry alone is fine, the primary photo alone is fine
        legacy, shadow = pair_with_unhydrated(("empty",))
        edit(shadow, PERSON1, lambda d: d["mediaGallery"][0].update(handle=hid("O9999")))
        code, doc = report_with(legacy, shadow, OPT, "1")
        self.assertEqual((code, doc["unexplained_by_area"]), (20, {"person": 1}))

    def test_an_index_entry_that_differs_in_another_field_is_not_explained(self):
        legacy, shadow = pair_with_unhydrated(("empty",))
        edit(shadow, "media/index.json", lambda d: [e.update(s3Key="media/other.png") for e in d if e["grampsId"] == "O9001"])
        code, doc = report_with(legacy, shadow, OPT, "1")
        self.assertEqual((code, doc["unexplained_by_area"]), (20, {"index": 1}))
        self.assertEqual(doc["unexplained_by_field"], {"s3Key": 1, "checksum": 1, "size": 1})
        self.assertEqual(doc["rules"][RULE]["areas"], {"media": 1, "person": 1})

    def test_a_person_file_with_another_unexplained_difference_is_unexplained_as_a_whole(self):
        legacy, shadow = pair_with_unhydrated(("empty",))
        edit(shadow, PERSON1, lambda d: d.update(displayName="Test Person Uno"))
        code, doc = report_with(legacy, shadow, OPT, "1")
        self.assertEqual((code, doc["unexplained_by_area"], doc["unexplained_by_field"]), (20, {"person": 1}, {"displayName": 1}))
        self.assertEqual(doc["rules"][RULE]["areas"], {"media": 1, "index": 1})

    def test_an_embedded_entry_of_a_media_whose_file_is_not_explained_is_not_explained(self):
        # O9002's media file is the same on both sides, but a person field still holds the empty capture: no media file, no explanation
        legacy, shadow = pair_with_unhydrated(("empty",))
        set_media(legacy, "O9002", UNHYDRATED["empty"], places=("person",))
        set_media(shadow, "O9002", HYDRATED, places=("person",))
        code, doc = report_with(legacy, shadow, OPT, "5")
        self.assertEqual((code, doc["baseline_unhydrated"]), (20, {"allowed": 5, "explained": 1}))
        self.assertEqual(doc["unexplained_by_area"], {"person": 1})
        # and the index entry alone
        legacy, shadow = pair_with_unhydrated(("empty",))
        set_media(legacy, "O9002", UNHYDRATED["empty"], places=("index",))
        set_media(shadow, "O9002", HYDRATED, places=("index",))
        code, doc = report_with(legacy, shadow, OPT, "5")
        self.assertEqual((code, doc["unexplained_by_area"]), (20, {"index": 1}))

    def test_a_second_gallery_entry_of_the_same_media_is_explained_too(self):
        legacy, shadow = pair_with_unhydrated(("empty",))
        for site, fields in ((legacy, UNHYDRATED["empty"]), (shadow, HYDRATED)):
            edit(site, PERSON1, lambda d: d["mediaGallery"].append(dict(d["mediaGallery"][0])))
        code, doc = report_with(legacy, shadow, OPT, "1")
        self.assertEqual((code, doc["unexplained"]), (10, 0))

    def test_a_pattern_on_a_file_that_is_not_a_media_object_is_not_explained(self):
        legacy, shadow = pair_with_unhydrated(("empty",))
        edit(legacy, PLACE_CITY, lambda d: d.update(handle=load(legacy, MEDIA_PHOTO)["handle"], **UNHYDRATED["empty"]))
        edit(shadow, PLACE_CITY, lambda d: d.update(handle=load(legacy, MEDIA_PHOTO)["handle"], **HYDRATED))
        code, doc = report_with(legacy, shadow, OPT, "5")
        self.assertEqual((code, doc["unexplained_by_area"]), (20, {"place": 1}))
        self.assertEqual(doc["rules"][RULE]["areas"], {"media": 1, "person": 1, "index": 1})

    def test_a_held_binary_and_a_stripped_pair_keep_their_own_rules(self):
        legacy, shadow = pair_with_held_photo()
        code, doc = report_with(legacy, shadow, OPT, "5")
        self.assertEqual((code, list(doc["rules"]), doc["baseline_unhydrated"]), (10, ["media-held-binary"], {"allowed": 5, "explained": 0}))
        legacy, shadow = pair_with_stripped_photo()
        code, doc = report_with(legacy, shadow, OPT, "5")
        self.assertEqual((code, doc["baseline_unhydrated"], set(doc["unexplained_by_field"])), (20, {"allowed": 5, "explained": 0}, {"checksum"}))

    # ---- precedence and the other allowances ------------------------------------------------------------------------------

    def test_a_media_that_media_location_stripped_explains_does_not_use_this_allowance(self):
        # an empty capture also fits the stripped pattern (two checksums, two sizes, neither missing): the stripped rule wins
        legacy, shadow = pair_with_unhydrated(("empty",))
        code, doc = report_with(legacy, shadow, "--expect-stripped", "1", OPT, "1")
        self.assertEqual(code, 10)
        self.assertEqual(list(doc["rules"]), ["media-location-stripped"])
        self.assertEqual(doc["stripped"], {"allowed": 1, "explained": 1})
        self.assertEqual(doc["baseline_unhydrated"], {"allowed": 1, "explained": 0}, "the allowance is not consumed")
        self.assertEqual(doc["rules"]["media-location-stripped"]["areas"], {"person": 1, "media": 1, "index": 1})

    def test_the_allowance_not_consumed_by_a_stripped_media_goes_to_the_next_one(self):
        # O9001 (empty capture) is taken by the stripped rule, O9002 (null capture, which cannot be a stripped pair) uses this allowance
        legacy, shadow = pair_with_unhydrated(("empty", "null"))
        code, doc = report_with(legacy, shadow, "--expect-stripped", "1", OPT, "1")
        self.assertEqual((code, doc["unexplained"]), (10, 0))
        self.assertEqual(doc["stripped"], {"allowed": 1, "explained": 1})
        self.assertEqual(doc["baseline_unhydrated"], {"allowed": 1, "explained": 1})
        self.assertEqual(doc["rules"]["media-location-stripped"]["areas"], {"person": 1, "media": 1, "index": 1})
        self.assertEqual(doc["rules"][RULE]["areas"], {"person": 1, "media": 1, "index": 1})

    def test_with_a_zero_stripped_allowance_the_stripped_rule_takes_nothing(self):
        legacy, shadow = pair_with_unhydrated(("empty",))
        code, doc = report_with(legacy, shadow, "--expect-stripped", "0", OPT, "1")
        self.assertEqual((code, list(doc["rules"])), (10, [RULE]))
        self.assertEqual((doc["stripped"], doc["baseline_unhydrated"]), ({"allowed": 0, "explained": 0}, {"allowed": 1, "explained": 1}))

    def sidecar_with(self, handles):
        import sqlite3
        folder = tempfile.mkdtemp(prefix="hfy-parity-sidecar-")
        self.addCleanup(shutil.rmtree, folder, True)
        path = os.path.join(folder, "state.sqlite")
        con = sqlite3.connect(path)
        con.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        con.execute("INSERT INTO meta VALUES ('media_location_stripped', ?)", (json.dumps({h: ["a" * 64, "b" * 64, "c" * 32] for h in handles}),))
        con.commit()
        con.close()
        return path

    def test_a_stripped_media_and_an_unhydrated_one_each_keep_their_own_rule_in_one_run(self):
        # O9002 is a real stripped copy (a real legacy checksum, another real shadow checksum); O9001 is an empty capture
        legacy, shadow = pair_with_unhydrated(("empty",))
        set_media(legacy, "O9002", dict(checksum="0" * 64, size=12, missing=False))
        set_media(shadow, "O9002", dict(checksum="c" * 64, size=12, missing=False))
        sidecar = self.sidecar_with([load(legacy, MEDIA_SCAN)["handle"]])
        code, doc = report_with(legacy, shadow, "--expect-stripped", "1", "--stripped-sidecar", sidecar, OPT, "1")
        self.assertEqual((code, doc["unexplained"]), (10, 0))
        self.assertEqual(doc["stripped"], {"allowed": 1, "explained": 1})
        self.assertEqual(doc["baseline_unhydrated"], {"allowed": 1, "explained": 1})
        self.assertEqual(sorted(doc["rules"]), sorted(["media-location-stripped", RULE]))
        for rule in ("media-location-stripped", RULE):
            self.assertEqual(doc["rules"][rule]["areas"], {"person": 1, "media": 1, "index": 1}, rule)
        # each allowance is its own: a stripped count of 0 leaves the stripped media unexplained and does not hand it to this rule
        code, doc = report_with(legacy, shadow, "--expect-stripped", "0", OPT, "2")
        self.assertEqual((code, doc["baseline_unhydrated"]), (20, {"allowed": 2, "explained": 1}))
        self.assertEqual(doc["rules"][RULE]["areas"], {"person": 1, "media": 1})

    def test_with_the_held_object_allowance_in_the_same_run(self):
        legacy, shadow = pair_with_unhydrated(("empty",))
        add_held_object(legacy, "person", 0)
        add_held_object(legacy, "media", 1)
        code, doc = report_with(legacy, shadow, "--expect-holds", "2", "--expect-stripped", "0", OPT, "1")
        self.assertEqual((code, doc["unexplained"]), (10, 0))
        self.assertEqual(doc["holds"], {"allowed": 2, "explained": 2})
        self.assertEqual(doc["baseline_unhydrated"], {"allowed": 1, "explained": 1})
        self.assertEqual(doc["rules"]["held-object"]["only_in_legacy"], 2)
        self.assertEqual(doc["rules"][RULE]["only_in_legacy"], 0)
        self.assertEqual(doc["classes"]["changed"]["explained"], 5, "the media file, the person file and the three index files (media/index.json is shared by both rules)")
        self.assertEqual(doc["rules"]["held-object"]["areas"]["index"], 3)
        self.assertEqual(doc["rules"][RULE]["areas"], {"media": 1, "person": 1, "index": 1})
        # without the media allowance the held objects are still explained and the capture is not
        code, doc = report_with(legacy, shadow, "--expect-holds", "2")
        self.assertEqual((code, doc["holds"]), (20, {"allowed": 2, "explained": 2}))
        self.assertNotIn(RULE, doc["rules"])

    # ---- the option ------------------------------------------------------------------------------------------------------

    def test_a_bad_count_is_a_usage_error_that_never_echoes_it(self):
        legacy, shadow = pair_with_unhydrated(("empty",))
        for bad in ("-1", "-0", "abc", "1.5", "3.0", "1e3", "+1", "0x10", " 1", "1 ", "٣", "secret-count-7", "", "9" * 5000):
            code, cap = run_cli(legacy, shadow, [OPT, bad])
            self.assertEqual(code, 64, repr(bad)[:20])
            self.assertEqual(cap.out.getvalue(), "")
            self.assertIn("usage_error", cap.err.getvalue())
            self.assertNotIn("secret-count-7", cap.out.getvalue() + cap.err.getvalue())
            self.assertNotIn("1.5", cap.err.getvalue())
            self.assertNotIn("9999", cap.err.getvalue())
            self.assertEqual(cap.logs, [])
        code, cap = run_cli(legacy, shadow, ["--expect-baseline", "1"])
        self.assertEqual(code, 64, "an abbreviation of the option is not accepted")

    def test_a_missing_value_is_a_usage_error_and_nothing_is_read_first(self):
        cap = Capture()
        self.assertEqual(cli.main(["--legacy", "a", "--shadow", "b", OPT], out=cap.out, err=cap.err), 64)
        runner = mock.Mock()
        cap = Capture()
        code = cli.main(["--legacy", "a", "--shadow", PREFIX, OPT, "-3"], run=runner, out=cap.out, err=cap.err)
        self.assertEqual(code, 64)
        runner.assert_not_called()

    def test_a_plain_count_is_accepted_in_both_spellings_with_leading_zeros_and_when_large(self):
        legacy, shadow = pair_with_unhydrated(("empty",))
        for args in ([OPT, "1"], [OPT + "=1"], [OPT, "001"], [OPT, "1" + "0" * 30]):
            code, doc = report_with(legacy, shadow, *args)
            self.assertEqual((code, doc["baseline_unhydrated"]["explained"]), (10, 1), args)

    def test_compare_refuses_a_negative_or_non_integer_allowance(self):
        site = build_site()
        for bad in (-1, 1.5, "2", True):
            with self.assertRaises(ValueError):
                compare_mod.compare(site, copy.deepcopy(site), rules.load_policy(), expect_baseline_unhydrated=bad)

    # ---- the report ------------------------------------------------------------------------------------------------------

    def test_the_text_report_shows_the_rule_and_the_allowance_and_no_handle_or_checksum(self):
        legacy, shadow = pair_with_unhydrated(("empty", "null"))
        code, cap = run_cli(legacy, shadow, [OPT, "2"])
        text = cap.out.getvalue()
        self.assertEqual(code, 10)
        self.assertIn(RULE, text)
        self.assertIn("media whose baseline was captured before the file was available: allowed 2, media explained 2", text)
        for secret in (hid("O9001"), hid("O9002"), EMPTY_HASH, REAL_HASH, "Test Photo", "I9001"):
            self.assertNotIn(secret, text)
        self.assertEqual(cap.err.getvalue(), "")

    def test_the_line_is_absent_without_the_option(self):
        legacy, shadow = pair_with_unhydrated(("empty",))
        code, cap = run_cli(legacy, shadow)
        self.assertNotIn("captured before the file was available", cap.out.getvalue())

    def test_the_json_carries_the_rule_and_a_closed_vocabulary(self):
        legacy, shadow = pair_with_unhydrated(("empty", "null"))
        code, doc = report_with(legacy, shadow, OPT, "1")
        self.assertLessEqual(set(doc["rules"]), set(rules.RULES))
        self.assertIn(RULE, doc["rules"])
        self.assertEqual(set(doc["baseline_unhydrated"]), {"allowed", "explained"})
        self.assertTrue(all(isinstance(v, int) for v in doc["baseline_unhydrated"].values()))
        self.assertLessEqual(set(doc["unexplained_by_field"]), compare_mod.FIELD_VOCABULARY | set(compare_mod.CODE_WORDS))

    def test_no_key_id_name_value_handle_or_checksum_appears_in_any_output(self):
        pairs = [pair_with_unhydrated(("empty", "null")),
                 pair_with_unhydrated(("empty",), shadow_fields=dict(size=0)),                       # a near miss
                 pair_with_unhydrated(("empty",), shadow_fields=dict(checksum=EMPTY_HASH))]
        for legacy, shadow in pairs:
            secrets = secrets_of(legacy, shadow)
            for extra in ([], ["--json"], [OPT, "1"], [OPT, "1", "--json"], [OPT, "9"], [OPT, "9", "--json"],
                          [OPT, "1", "--expect-stripped", "1", "--expect-holds", "1"]):
                code, cap = run_cli(legacy, shadow, extra)
                text = cap.everything.replace(cap.tmp, "<tmp>")
                for secret in secrets:
                    self.assertNotIn(secret, text, "%r leaked (exit %s, %s)" % (secret[:6], code, extra))
                self.assertEqual(cap.logs, [])

    def test_a_failure_with_the_option_prints_a_code_word_only(self):
        site = build_site()
        with mock.patch.object(compare_mod, "compare", side_effect=ValueError("I9001 Test Person One")):
            code, cap = run_cli(site, copy.deepcopy(site), [OPT, "3"])
        self.assertEqual((code, cap.err.getvalue()), (70, "hfy-parity: internal_error (ValueError)\n"))

    def test_the_command_line_entry_point_takes_the_option(self):
        legacy, shadow = pair_with_unhydrated(("empty",))
        with tempfile.TemporaryDirectory() as tmp:
            for name, site in (("legacy", legacy), ("shadow", shadow)):
                os.makedirs(os.path.join(tmp, name))
                write_tree(os.path.join(tmp, name), site)
            base = [sys.executable, "-I", BIN, "--legacy", os.path.join(tmp, "legacy"), "--shadow", os.path.join(tmp, "shadow")]
            without = subprocess.run(base, capture_output=True, text=True)
            with_option = subprocess.run(base + [OPT, "1"], capture_output=True, text=True)
            bad = subprocess.run(base + [OPT, "-1"], capture_output=True, text=True)
        self.assertEqual((without.returncode, with_option.returncode, bad.returncode), (20, 10, 64))
        self.assertIn(RULE, with_option.stdout)
        self.assertEqual(with_option.stderr, "")


# ---- HFY-TSK-376 (follow-up): the cloud stores every JPEG as .jpg, the legacy export kept the file's own suffix ---------------

def with_person_index_photos(site):
    """person/index.json carries each person's primaryPhoto as a bare s3Key text (as the renderer's search manifest does)."""
    keys = {"I9001": load(site, PERSON1)["primaryPhoto"]["s3Key"], "I9002": load(site, SCAN_PERSON)["primaryPhoto"]["s3Key"]}
    edit(site, "person/index.json", lambda d: [e.update(primaryPhoto=keys[e["grampsId"]]) for e in d["people"]])


def respell(site, gid, key):
    """Set the s3Key of O9001 or O9002 on the media file, the index entry, the person fields and the person/index.json text."""
    set_media(site, gid, {"s3Key": key})
    person_gid = "I9001" if gid == "O9001" else "I9002"
    edit(site, "person/index.json", lambda d: [e.update(primaryPhoto=key) for e in d["people"] if e["grampsId"] == person_gid])


def pair_with_jpeg_spelling(legacy_suffix=".jpeg", variants=("empty",), second_spelling=False):
    """Legacy: O9001 (and O9002 with ``second_spelling``) is an empty capture whose s3Key ends in ``legacy_suffix``; shadow: .jpg."""
    legacy, shadow = pair_with_unhydrated(variants)
    for site in (legacy, shadow):
        with_person_index_photos(site)
    gids = ("O9001", "O9002") if second_spelling else ("O9001",)
    for gid in gids:
        respell(legacy, gid, "media/%s%s" % (hid(gid), legacy_suffix))
    return legacy, shadow


class MediaBaselineUnhydratedJpegSpelling(unittest.TestCase):
    """The cloud stores every image/jpeg as media/<handle>.jpg (api/src/sync/media.js MEDIA_TYPES); the legacy export kept the file's suffix."""

    def test_the_cloud_suffix_is_the_one_the_code_uses(self):
        from hfygramps.addon import mediafile
        from hfygramps.render.transform import derive_media_extension
        with open(os.path.join(os.path.dirname(GRAMPS), "api", "src", "sync", "media.js"), encoding="utf-8") as fh:
            js = fh.read()
        match = re.search(r"MEDIA_TYPES = Object\.freeze\(\{(.*?)\}\)", js, re.S)
        self.assertIsNotNone(match)
        cloud = dict(re.findall(r'"([a-z/]+)":\s*"(\.[a-z]+)"', match.group(1)))
        self.assertEqual(cloud["image/jpeg"], compare_mod.CLOUD_JPEG_SUFFIX)
        self.assertEqual(mediafile.EXTENSIONS["image/jpeg"], compare_mod.CLOUD_JPEG_SUFFIX)
        self.assertEqual(compare_mod.JPEG_MIME, "image/jpeg")
        # the legacy ETL keeps the file's own lower-cased suffix: that is where .jpeg comes from
        self.assertEqual(derive_media_extension("/x/Photo.JPEG", "image/jpeg"), ".jpeg")
        self.assertEqual(sorted(compare_mod.LEGACY_JPEG_SUFFIXES), [".jpeg"])

    def test_a_jpeg_spelling_is_explained_on_all_five_places_and_counts_once(self):
        for suffix in (".jpeg", ".JPEG", ".Jpeg"):
            for variant in ("empty", "null"):
                legacy, shadow = pair_with_jpeg_spelling(suffix, (variant,))
                code, doc = report_with(legacy, shadow, OPT, "1")
                self.assertEqual((code, doc["unexplained"], doc["verdict"]), (10, 0, "explained"), (suffix, variant))
                row = doc["rules"][RULE]
                self.assertEqual((row["changed"], row["areas"]), (4, {"person": 1, "media": 1, "index": 2}), (suffix, variant))
                self.assertEqual(list(doc["rules"]), [RULE])
                self.assertEqual(doc["baseline_unhydrated"], {"allowed": 1, "explained": 1}, "one media uses one unit of the allowance")

    def test_without_the_option_or_beyond_the_count_the_spelling_stays_unexplained(self):
        legacy, shadow = pair_with_jpeg_spelling()
        code, doc = report_with(legacy, shadow)
        self.assertEqual(code, 20)
        self.assertEqual(doc["unexplained_by_area"], {"media": 1, "person": 1, "index": 2})
        self.assertEqual(set(doc["unexplained_by_field"]), {"checksum", "size", "s3Key", "primaryPhoto"})
        code, doc = report_with(legacy, shadow, OPT, "0")
        self.assertEqual((code, doc["unexplained_by_area"]), (20, {"media": 1, "person": 1, "index": 2}))
        # two such media, one unit: the media after the first stay unexplained, person/index.json included
        legacy, shadow = pair_with_jpeg_spelling(variants=("empty", "empty"), second_spelling=True)
        code, doc = report_with(legacy, shadow, OPT, "1")
        self.assertEqual(code, 20)
        self.assertEqual(doc["baseline_unhydrated"], {"allowed": 1, "explained": 1})
        self.assertEqual(doc["rules"][RULE]["areas"], {"media": 1, "person": 1})
        self.assertEqual(doc["unexplained_by_area"], {"media": 1, "person": 1, "index": 2})
        code, doc = report_with(legacy, shadow, OPT, "2")
        self.assertEqual((code, doc["unexplained"], doc["baseline_unhydrated"]), (10, 0, {"allowed": 2, "explained": 2}))

    def test_a_spelling_that_is_not_jpeg_to_jpg_on_the_same_stem_is_not_explained(self):
        h = hid("O9001")
        near_misses = (
            ("another stem", "media/%s.jpeg" % hid("O9999")),
            ("a stem with a suffix", "media/%sx.jpeg" % h),
            ("a path", "media/sub/%s.jpeg" % h),
            ("another folder", "uploads/%s.jpeg" % h),
            ("another case of the folder", "Media/%s.jpeg" % h),
            ("png to jpg", "media/%s.png" % h),
            ("gif to jpg", "media/%s.gif" % h),
            ("tif to jpg", "media/%s.tif" % h),
            ("jpe", "media/%s.jpe" % h),
            ("jfif", "media/%s.jfif" % h),
            ("a double suffix", "media/%s.jpeg.jpg" % h),
            ("a space", "media/%s.jpeg " % h),
            ("no suffix", "media/%s" % h),
            ("the same key", "media/%s.jpg" % h),
            ("text that is not a key", 5))
        for label, legacy_key in near_misses:
            legacy, shadow = pair_with_jpeg_spelling()
            respell(legacy, "O9001", legacy_key)
            code, doc = report_with(legacy, shadow, OPT, "5")
            if label == "the same key":
                self.assertEqual((code, doc["unexplained"]), (10, 0), label)       # no spelling difference at all: the plain pattern
                continue
            self.assertEqual((code, doc["baseline_unhydrated"]["explained"]), (20, 0), label)
            self.assertNotIn(RULE, doc["rules"], label)
            self.assertEqual(doc["unexplained_by_area"], {"media": 1, "person": 1, "index": 2}, label)

    def test_the_reverse_spelling_and_another_shadow_suffix_are_not_explained(self):
        for label, legacy_suffix, shadow_suffix in (("jpg to jpeg", ".jpg", ".jpeg"), ("jpeg to JPG", ".jpeg", ".JPG"),
                                                    ("jpeg to jpeg", ".jpeg", ".jpeg"), ("jpeg to png", ".jpeg", ".png")):
            legacy, shadow = pair_with_jpeg_spelling(legacy_suffix)
            respell(shadow, "O9001", "media/%s%s" % (hid("O9001"), shadow_suffix))
            code, doc = report_with(legacy, shadow, OPT, "5")
            if legacy_suffix == shadow_suffix:
                # the same key on both sides: nothing about the key, the plain pattern applies
                self.assertEqual((code, doc["unexplained"]), (10, 0), label)
                continue
            self.assertEqual((code, doc["baseline_unhydrated"]["explained"]), (20, 0), label)

    def test_the_spelling_needs_a_jpeg_mime_and_every_other_field_equal(self):
        for label, change in (
                ("a png mime", lambda d: d.update(mime="image/png")),
                ("no mime", lambda d: d.pop("mime")),
                ("a null mime", lambda d: d.update(mime=None)),
                ("an upper-case mime", lambda d: d.update(mime="IMAGE/JPEG"))):
            legacy, shadow = pair_with_jpeg_spelling()
            edit(legacy, MEDIA_PHOTO, change)
            edit(shadow, MEDIA_PHOTO, change)
            code, doc = report_with(legacy, shadow, OPT, "5")
            self.assertEqual((code, doc["baseline_unhydrated"]["explained"]), (20, 0), label)
            self.assertNotIn(RULE, doc["rules"], label)
        for label, field_change in (("title", lambda d: d.update(title="Another Title")), ("regions", lambda d: d.update(regions=[{"rect": [1]}])),
                                    ("grampsId", lambda d: d.update(grampsId="O9777")), ("an added field", lambda d: d.update(extra=1))):
            for spelled in (True, False):          # the spelling difference present, and the same key (.jpeg both sides) with the field differing
                legacy, shadow = pair_with_jpeg_spelling()
                if not spelled:
                    respell(shadow, "O9001", "media/%s.jpeg" % hid("O9001"))
                edit(shadow, MEDIA_PHOTO, field_change)
                code, doc = report_with(legacy, shadow, OPT, "5")
                self.assertEqual((code, doc["baseline_unhydrated"]["explained"]), (20, 0), (label, spelled))
                self.assertNotIn(RULE, doc["rules"], (label, spelled))

    def test_an_entry_that_spells_the_key_otherwise_than_its_media_file_is_not_explained(self):
        # the media file has the pair .jpeg / .jpg, an embedded entry has the pair .JPEG / .jpg, or no spelling difference at all
        for place in ("index", "person"):
            for entry_legacy_key in ("media/%s.JPEG" % hid("O9001"), "media/%s.jpg" % hid("O9001")):
                legacy, shadow = pair_with_jpeg_spelling()
                set_media(legacy, "O9001", {"s3Key": entry_legacy_key}, places=(place,))
                code, doc = report_with(legacy, shadow, OPT, "1")
                self.assertEqual(code, 20, (place, entry_legacy_key))
                self.assertEqual(doc["baseline_unhydrated"], {"allowed": 1, "explained": 1})
                bad_area = "index" if place == "index" else "person"
                self.assertIn(bad_area, doc["unexplained_by_area"], (place, entry_legacy_key))
                self.assertIn("checksum", doc["unexplained_by_field"], "the entry is not the pattern, so its checksum stays unexplained too")
        # an entry whose key differs while the media file's key is the same on both sides
        legacy, shadow = pair_with_unhydrated(("empty",))
        for site in (legacy, shadow):
            with_person_index_photos(site)
        set_media(legacy, "O9001", {"s3Key": "media/%s.jpeg" % hid("O9001")}, places=("person",))
        code, doc = report_with(legacy, shadow, OPT, "1")
        self.assertEqual((code, doc["unexplained_by_area"]), (20, {"person": 1}))

    # ---- person/index.json -------------------------------------------------------------------------------------------------

    def test_the_person_index_entry_is_explained_only_with_an_explained_media(self):
        legacy, shadow = pair_with_jpeg_spelling()
        code, doc = report_with(legacy, shadow, OPT, "1")
        self.assertEqual((code, doc["unexplained"]), (10, 0))
        self.assertEqual(doc["rules"][RULE]["areas"]["index"], 2, "media/index.json and person/index.json")
        # the media is not explained (no option): the person index entry is not either
        code, doc = report_with(legacy, shadow)
        self.assertEqual(doc["unexplained_by_field"].get("primaryPhoto"), 1)

    def test_a_person_index_entry_of_another_persons_photo_is_not_explained(self):
        legacy, shadow = pair_with_jpeg_spelling()
        # person two's photo (O9002) is not respelled; person two's index text claims O9001's pair
        for site, key in ((legacy, "media/%s.jpeg" % hid("O9001")), (shadow, "media/%s.jpg" % hid("O9001"))):
            edit(site, "person/index.json", lambda d: [e.update(primaryPhoto=key) for e in d["people"] if e["grampsId"] == "I9002"])
        code, doc = report_with(legacy, shadow, OPT, "5")
        self.assertEqual(code, 20)
        self.assertEqual(doc["unexplained_by_field"], {"primaryPhoto": 1})
        self.assertEqual(doc["unexplained_by_area"], {"index": 1})

    def test_a_person_index_text_that_is_not_the_pair_of_the_media_is_not_explained(self):
        h = hid("O9001")
        for label, legacy_text, shadow_text in (
                ("another stem", "media/%s.jpeg" % hid("O9999"), "media/%s.jpg" % hid("O9999")),
                ("png to jpg", "media/%s.png" % h, "media/%s.jpg" % h),
                ("jpeg to png", "media/%s.jpeg" % h, "media/%s.png" % h),
                ("JPEG to jpg (the media has jpeg)", "media/%s.JPEG" % h, "media/%s.jpg" % h),
                ("a null text", None, "media/%s.jpg" % h),
                ("a text that became null", "media/%s.jpeg" % h, None)):
            legacy, shadow = pair_with_jpeg_spelling()
            edit(legacy, "person/index.json", lambda d: [e.update(primaryPhoto=legacy_text) for e in d["people"] if e["grampsId"] == "I9001"])
            edit(shadow, "person/index.json", lambda d: [e.update(primaryPhoto=shadow_text) for e in d["people"] if e["grampsId"] == "I9001"])
            code, doc = report_with(legacy, shadow, OPT, "5")
            self.assertEqual((code, doc["unexplained_by_area"]), (20, {"index": 1}), label)
            self.assertEqual(doc["unexplained_by_field"], {"primaryPhoto": 1}, label)

    def test_a_person_index_entry_with_any_other_difference_is_unexplained(self):
        legacy, shadow = pair_with_jpeg_spelling()
        edit(shadow, "person/index.json", lambda d: [e.update(displayName="Test Person Uno") for e in d["people"] if e["grampsId"] == "I9001"])
        code, doc = report_with(legacy, shadow, OPT, "1")
        self.assertEqual((code, doc["unexplained_by_area"], doc["unexplained_by_field"]), (20, {"index": 1}, {"displayName": 1}))
        self.assertEqual(doc["rules"][RULE]["areas"], {"media": 1, "person": 1, "index": 1}, "media/index.json is explained, person/index.json is not")

    def test_the_person_files_must_name_the_same_photo_and_the_same_person(self):
        for label, side, change in (
                ("the legacy person file names another photo", "legacy", lambda d: d["primaryPhoto"].update(handle=hid("O9002"))),
                ("the shadow person file names another photo", "shadow", lambda d: d["primaryPhoto"].update(handle=hid("O9002"))),
                ("the shadow person file has no photo", "shadow", lambda d: d.pop("primaryPhoto")),
                ("the legacy person file is another person", "legacy", lambda d: d.update(handle=hid("I9999"))),
                ("the shadow person file is another person", "shadow", lambda d: d.update(handle=hid("I9999")))):
            legacy, shadow = pair_with_jpeg_spelling()
            edit(legacy if side == "legacy" else shadow, PERSON1, change)
            code, doc = report_with(legacy, shadow, OPT, "5")
            self.assertEqual(code, 20, label)
            self.assertGreaterEqual(doc["unexplained_by_field"].get("primaryPhoto", 0), 1, label)
            self.assertEqual(doc["unexplained_by_area"].get("index"), 1, label)
        # an entry without a person file
        legacy, shadow = pair_with_jpeg_spelling()
        del legacy[PERSON1]
        del shadow[PERSON1]
        code, doc = report_with(legacy, shadow, OPT, "5")
        self.assertEqual(code, 20)
        self.assertEqual(doc["unexplained_by_field"], {"primaryPhoto": 1})

    def test_the_person_index_text_is_not_read_by_the_other_rules_or_other_entries(self):
        # a person/index.json primaryPhoto difference with no media involved is unexplained, with and without the option
        legacy, shadow = build_site(), build_site()
        for site in (legacy, shadow):
            with_users(site)
            with_person_index_photos(site)
        edit(legacy, "person/index.json", lambda d: [e.update(primaryPhoto="media/%s.jpeg" % hid("O9001")) for e in d["people"] if e["grampsId"] == "I9001"])
        for extra in ([], [OPT, "5"]):
            code, doc = report_with(legacy, shadow, *extra)
            self.assertEqual((code, doc["unexplained_by_field"]), (20, {"primaryPhoto": 1}), extra)

    # ---- precedence and the stripped rule ---------------------------------------------------------------------------------

    def test_the_stripped_rule_does_not_explain_an_s3key_and_keeps_its_behaviour(self):
        # a real stripped copy whose key is also spelled .jpeg / .jpg: the checksum difference is stripped, the key is not
        legacy, shadow = build_site(), build_site()
        for site in (legacy, shadow):
            with_users(site)
        strip_photo(shadow)
        for site in (legacy, shadow):
            with_person_index_photos(site)
        respell(legacy, "O9001", "media/%s.jpeg" % hid("O9001"))
        code, doc = report_with(legacy, shadow, "--expect-stripped", "1", OPT, "1")
        self.assertEqual(code, 20)
        self.assertEqual(doc["stripped"], {"allowed": 1, "explained": 1})
        self.assertEqual(doc["baseline_unhydrated"], {"allowed": 1, "explained": 0})
        self.assertEqual(set(doc["unexplained_by_field"]), {"s3Key", "primaryPhoto"})
        self.assertNotIn(RULE, doc["rules"])

    def test_a_media_the_stripped_rule_explains_keeps_that_rule_and_the_allowance(self):
        # an empty capture with the key spelling, taken by the stripped rule (its pattern fits, no sidecar): the stripped rule wins on the
        # checksum and size and does not explain the key, so the run is unexplained, and the allowance of this rule is not consumed
        legacy, shadow = pair_with_jpeg_spelling()
        code, doc = report_with(legacy, shadow, "--expect-stripped", "1", OPT, "1")
        self.assertEqual(code, 20)
        self.assertEqual(doc["baseline_unhydrated"], {"allowed": 1, "explained": 0})
        self.assertEqual(doc["stripped"], {"allowed": 1, "explained": 1})
        self.assertEqual(set(doc["unexplained_by_field"]), {"s3Key", "primaryPhoto"})
        # with the stripped allowance at 0 the rule takes it
        code, doc = report_with(legacy, shadow, "--expect-stripped", "0", OPT, "1")
        self.assertEqual((code, doc["unexplained"], doc["baseline_unhydrated"]), (10, 0, {"allowed": 1, "explained": 1}))

    def test_the_held_object_allowance_and_the_spelling_in_one_run(self):
        legacy, shadow = pair_with_jpeg_spelling()
        add_held_object(legacy, "person", 0)
        code, doc = report_with(legacy, shadow, "--expect-holds", "1", OPT, "1")
        self.assertEqual((code, doc["unexplained"]), (10, 0))
        self.assertEqual((doc["holds"], doc["baseline_unhydrated"]), ({"allowed": 1, "explained": 1}, {"allowed": 1, "explained": 1}))

    def test_nothing_in_the_output_names_a_handle_a_key_or_a_checksum(self):
        for legacy, shadow in (pair_with_jpeg_spelling(), pair_with_jpeg_spelling(".png")):
            secrets = secrets_of(legacy, shadow)
            for extra in ([], ["--json"], [OPT, "1"], [OPT, "1", "--json"]):
                code, cap = run_cli(legacy, shadow, extra)
                text = cap.everything.replace(cap.tmp, "<tmp>")
                for secret in secrets:
                    self.assertNotIn(secret, text, "%r leaked (exit %s, %s)" % (secret[:6], code, extra))


class HeldObjects(unittest.TestCase):
    KINDS = ("person", "family", "event", "note", "place", "media")

    def test_every_kind_of_whole_object_and_its_index_entry_is_explained_under_the_allowance(self):
        legacy, shadow, keys = pair_with_holds(self.KINDS)
        self.assertEqual(len(keys), 6)
        code, doc = report_with(legacy, shadow, "--expect-holds", "6")
        self.assertEqual((code, doc["unexplained"]), (10, 0))
        row = doc["rules"]["held-object"]
        self.assertEqual((row["only_in_legacy"], row["changed"], row["only_in_render"]), (6, 4, 0))
        self.assertEqual(row["areas"], {"person": 1, "family": 1, "event": 1, "note": 1, "place": 1, "media": 1, "index": 4})
        self.assertEqual(doc["holds"], {"allowed": 6, "explained": 6})
        self.assertEqual(list(doc["rules"]), ["held-object"])

    def test_the_boundary_n_minus_one_n_and_n_plus_one(self):
        legacy, shadow, _ = pair_with_holds(["person"] * 3)
        for n, code, explained in ((2, 20, 2), (3, 10, 3), (4, 10, 3)):
            got, doc = report_with(legacy, shadow, "--expect-holds", str(n))
            self.assertEqual(got, code, n)
            self.assertEqual(doc["holds"], {"allowed": n, "explained": explained}, n)
            self.assertEqual(doc["classes"]["only_in_legacy"], {"explained": explained, "unexplained": 3 - explained}, n)
            if n < 3:
                # the index entries follow the same count: the person index and the search index each lose one entry too many
                self.assertEqual(doc["unexplained_by_field"], {"entry_removed": 2})
                self.assertEqual(doc["unexplained_by_area"], {"person": 1, "index": 2})
            else:
                self.assertEqual(doc["unexplained_by_field"], {})

    def test_the_boundary_with_a_mix_of_areas(self):
        legacy, shadow, _ = pair_with_holds(["event", "place", "media", "person"])
        for n, code in ((3, 20), (4, 10), (5, 10)):
            got, doc = report_with(legacy, shadow, "--expect-holds=%d" % n)
            self.assertEqual(got, code, n)
        got, doc = report_with(legacy, shadow, "--expect-holds", "3")
        self.assertEqual(doc["classes"]["only_in_legacy"], {"explained": 3, "unexplained": 1})
        self.assertEqual(doc["unexplained"], 2)       # the file, and the one index it left (the person index and the search index)

    def test_without_the_option_nothing_changes(self):
        legacy, shadow, _ = pair_with_holds(["person", "note"])
        code, doc = report_with(legacy, shadow)
        self.assertEqual(code, 20)
        self.assertNotIn("holds", doc)
        self.assertNotIn("held-object", doc["rules"])
        self.assertEqual(doc["classes"]["only_in_legacy"], {"explained": 0, "unexplained": 2})
        self.assertEqual(doc["unexplained_by_field"], {"entry_removed": 2})
        code, cap = run_cli(legacy, shadow)
        self.assertNotIn("held objects", cap.out.getvalue())

    def test_a_zero_allowance_explains_nothing(self):
        legacy, shadow, _ = pair_with_holds(["person"])
        code, doc = report_with(legacy, shadow, "--expect-holds", "0")
        self.assertEqual(code, 20)
        self.assertEqual(doc["holds"], {"allowed": 0, "explained": 0})
        self.assertEqual(doc["classes"]["only_in_legacy"], {"explained": 0, "unexplained": 1})

    def test_the_text_report_shows_the_rule_and_the_allowance(self):
        legacy, shadow, _ = pair_with_holds(["person", "media"])
        code, cap = run_cli(legacy, shadow, ["--expect-holds", "5"])
        text = cap.out.getvalue()
        self.assertEqual(code, 10)
        self.assertRegex(text, r"(?m)^held-object +2 +3 +0 ")
        self.assertIn("held objects: allowed 5, whole-object absences explained 2", text)

    def test_policy_rules_are_applied_first_and_do_not_use_the_allowance(self):
        legacy, shadow, _ = pair_with_holds(["person"])
        del shadow[PLACE_STREET]                    # an excluded place: its own rule
        edit(shadow, "place/index.json", lambda d: d.__setitem__(slice(None), [e for e in d if e["grampsId"] != "P9002"]))
        edit(legacy, MEDIA_SCAN, lambda d: d.update(mime="application/pdf"))
        del shadow[MEDIA_SCAN]                      # a held type: its own rule
        edit(shadow, "media/index.json", lambda d: d.__setitem__(slice(None), [e for e in d if e["grampsId"] != "O9002"]))
        code, doc = report_with(legacy, shadow, "--expect-holds", "1")
        self.assertEqual((code, doc["unexplained"]), (10, 0))
        self.assertEqual(doc["holds"], {"allowed": 1, "explained": 1})
        self.assertEqual(doc["rules"]["held-object"]["only_in_legacy"], 1)
        self.assertEqual(doc["rules"]["excluded-place"]["only_in_legacy"], 1)
        self.assertEqual(doc["rules"]["media-held-mime"]["only_in_legacy"], 1)

    def test_the_allowance_does_not_reach_anything_but_a_missing_data_file(self):
        legacy, shadow = build_site(), build_site()
        edit(shadow, PERSON1, lambda d: d.update(displayName="Test Person Uno"))                # a changed value
        shadow["event/%s.json" % hid("E9009")] = dumps({"grampsId": "E9009"})                    # a file only in the shadow
        del shadow["place/index.json"]                                                          # an index file missing
        edit(shadow, "media/index.json", lambda d: d.pop())                                      # an index entry, its file still there
        code, doc = report_with(legacy, shadow, "--expect-holds", "50")
        self.assertEqual(code, 20)
        self.assertEqual(doc["holds"], {"allowed": 50, "explained": 0})
        self.assertEqual(doc["classes"]["only_in_legacy"], {"explained": 0, "unexplained": 1})
        self.assertEqual(doc["classes"]["only_in_render"], {"explained": 0, "unexplained": 1})
        self.assertEqual(doc["unexplained_by_field"], {"displayName": 1, "entry_removed": 1})
        self.assertNotIn("held-object", doc["rules"])

    def test_an_index_entry_of_another_area_is_not_matched_to_a_held_object(self):
        legacy, shadow, keys = pair_with_holds(["person"])
        # a place index entry whose id equals the held person's id is not that person's entry
        edit(legacy, "place/index.json", lambda d: d.append({"displayName": "Test", "grampsId": "I9100", "handle": hid("I9100")}))
        code, doc = report_with(legacy, shadow, "--expect-holds", "1")
        self.assertEqual(code, 20)
        self.assertEqual(doc["unexplained_by_field"], {"entry_removed": 1})
        self.assertEqual(doc["unexplained_by_area"], {"index": 1})

    def test_the_selection_is_stable_and_the_report_is_the_same_twice(self):
        legacy, shadow, _ = pair_with_holds(["note", "person", "family"])
        first = report_with(legacy, shadow, "--expect-holds", "2")
        second = report_with(copy.deepcopy(legacy), copy.deepcopy(shadow), "--expect-holds", "2")
        self.assertEqual(first, second)
        self.assertEqual(first[0], 20)


class ExpectHoldsUsage(unittest.TestCase):
    def test_a_negative_or_non_integer_count_is_a_usage_error_and_is_never_echoed(self):
        for value in ("-1", "-0", "2.5", "3.0", "1e2", "", " 3", "3 ", "+3", "0x10", "٣", "Test Person Secret", "9" * 3 + "x"):
            cap = Capture()
            code = cli.main(["--legacy", "a", "--shadow", "b", "--expect-holds", value], out=cap.out, err=cap.err)
            self.assertEqual(code, 64, repr(value))
            self.assertEqual(cap.out.getvalue(), "")
            self.assertIn("usage_error", cap.err.getvalue())
            for echoed in ("Secret", "2.5", "0x10", "1e2", "999"):
                self.assertNotIn(echoed, cap.err.getvalue(), repr(value))

    def test_a_missing_value_is_a_usage_error(self):
        cap = Capture()
        code = cli.main(["--legacy", "a", "--shadow", "b", "--expect-holds"], out=cap.out, err=cap.err)
        self.assertEqual(code, 64)

    def test_the_usage_error_comes_before_anything_is_read_or_downloaded(self):
        runner = mock.Mock()
        cap = Capture()
        code = cli.main(["--legacy", "a", "--shadow", PREFIX, "--expect-holds", "-3"], run=runner, out=cap.out, err=cap.err)
        self.assertEqual(code, 64)
        runner.assert_not_called()

    def test_a_plain_count_is_accepted_in_both_spellings_and_with_leading_zeros(self):
        legacy, shadow, _ = pair_with_holds(["person"])
        for args in (["--expect-holds", "1"], ["--expect-holds=1"], ["--expect-holds", "001"]):
            code, doc = report_with(legacy, shadow, *args)
            self.assertEqual((code, doc["holds"]), (10, {"allowed": 1, "explained": 1}), args)

    def test_compare_refuses_a_negative_or_non_integer_allowance(self):
        site = build_site()
        for bad in (-1, 1.5, "2", True):
            with self.assertRaises(ValueError):
                compare_mod.compare(site, copy.deepcopy(site), rules.load_policy(), expect_holds=bad)

    def test_the_command_line_entry_point_takes_the_option(self):
        legacy, shadow, _ = pair_with_holds(["person"])
        with tempfile.TemporaryDirectory() as tmp:
            for name, site in (("legacy", legacy), ("shadow", shadow)):
                os.makedirs(os.path.join(tmp, name))
                write_tree(os.path.join(tmp, name), site)
            base = [sys.executable, "-I", BIN, "--legacy", os.path.join(tmp, "legacy"), "--shadow", os.path.join(tmp, "shadow")]
            without = subprocess.run(base, capture_output=True, text=True)
            with_option = subprocess.run(base + ["--expect-holds", "1"], capture_output=True, text=True)
            bad = subprocess.run(base + ["--expect-holds", "-1"], capture_output=True, text=True)
        self.assertEqual((without.returncode, with_option.returncode, bad.returncode), (20, 10, 64))
        self.assertIn("held-object", with_option.stdout)
        self.assertEqual(with_option.stderr, "")


class NoLeaksOfTheNewRules(unittest.TestCase):
    def scenarios(self):
        legacy, shadow = pair_with_held_photo()
        keys = [add_held_object(legacy, kind, n) for n, kind in enumerate(HeldObjects.KINDS)]
        for site, text in ((legacy, "12 March 1950"), (shadow, "")):
            edit(site, EVENT_BIRTH, lambda d: d["date"].update(text=text))
            edit(site, PERSON1, lambda d: d["events"][0]["date"].update(text=text))
        bad_legacy, bad_shadow = pair_with_held_photo(size=12)       # a near miss: unexplained
        return [(legacy, shadow), (bad_legacy, bad_shadow)], keys

    def test_no_key_id_name_or_value_appears_for_the_new_rules(self):
        pairs, _ = self.scenarios()
        for legacy, shadow in pairs:
            secrets = secrets_of(legacy, shadow)
            for extra in ([], ["--json"], ["--expect-holds", "2"], ["--expect-holds", "2", "--json"], ["--expect-holds", "9"]):
                code, cap = run_cli(legacy, shadow, extra)
                text = cap.everything.replace(cap.tmp, "<tmp>")
                for secret in secrets:
                    self.assertNotIn(secret, text, "%r leaked (exit %s, %s)" % (secret[:6], code, extra))
                self.assertEqual(cap.logs, [])

    def test_the_report_vocabulary_stays_closed_with_the_option(self):
        pairs, _ = self.scenarios()
        code, doc = report_with(pairs[0][0], pairs[0][1], "--expect-holds", "2")
        self.assertLessEqual(set(doc["rules"]), set(rules.RULES))
        self.assertLessEqual(set(doc["unexplained_by_field"]), compare_mod.FIELD_VOCABULARY | set(compare_mod.CODE_WORDS))
        self.assertEqual(set(doc["holds"]), {"allowed", "explained"})
        self.assertTrue(all(isinstance(v, int) for v in doc["holds"].values()))

    def test_a_failure_with_the_option_prints_a_code_word_only(self):
        site = build_site()
        with mock.patch.object(compare_mod, "compare", side_effect=ValueError("I9001 Test Person One")):
            code, cap = run_cli(site, copy.deepcopy(site), ["--expect-holds", "3"])
        self.assertEqual((code, cap.err.getvalue()), (70, "hfy-parity: internal_error (ValueError)\n"))


# ---- unexplained differences ------------------------------------------------------------------------------------------

class Unexplained(unittest.TestCase):
    def test_a_changed_value_is_unexplained_and_named_by_field_only(self):
        legacy, shadow = build_site(), build_site()
        edit(shadow, PERSON1, lambda d: d.update(displayName="Test Person Uno"))
        code, doc = report(legacy, shadow)
        self.assertEqual(code, 20)
        self.assertEqual(doc["verdict"], "unexplained")
        self.assertEqual(doc["classes"]["changed"], {"explained": 0, "unexplained": 1})
        self.assertEqual(doc["unexplained_by_area"], {"person": 1})
        self.assertEqual(doc["unexplained_by_field"], {"displayName": 1})

    def test_a_field_name_outside_the_vocabulary_is_reported_as_other(self):
        legacy, shadow = build_site(), build_site()
        edit(shadow, PERSON1, lambda d: d.update(**{"Secret Custom Field": "Test Person Value"}))
        code, doc = report(legacy, shadow)
        self.assertEqual((code, doc["unexplained_by_field"]), (20, {"other": 1}))

    def test_a_key_only_in_the_legacy_export(self):
        legacy, shadow = build_site(), build_site()
        legacy["person/I9005.json"] = dumps({"grampsId": "I9005", "displayName": "Test Person Five"})
        del legacy["family/%s.json" % hid("F9001")]
        legacy["family/%s.json" % hid("F9002")] = dumps({"grampsId": "F9002"})
        code, doc = report(legacy, shadow)
        self.assertEqual(code, 20)
        self.assertEqual(doc["classes"]["only_in_legacy"]["unexplained"], 2)
        self.assertEqual(doc["classes"]["only_in_render"]["unexplained"], 1)

    def test_a_key_only_in_the_shadow_output(self):
        legacy, shadow = build_site(), build_site()
        shadow["event/%s.json" % hid("E9009")] = dumps({"grampsId": "E9009"})
        code, doc = report(legacy, shadow)
        self.assertEqual(code, 20)
        self.assertEqual(doc["classes"]["only_in_render"], {"explained": 0, "unexplained": 1})
        self.assertEqual(doc["unexplained_by_area"], {"event": 1})

    def test_a_shadow_key_the_renderer_does_not_own(self):
        legacy, shadow = build_site(), build_site()
        shadow["person/graph.json"] = dumps({})
        shadow["media/%s.jpg" % hid("O9001")] = b"bytes"
        code, doc = report(legacy, shadow)
        self.assertEqual(code, 20)
        self.assertEqual(doc["unexplained_by_field"], {"unowned_key": 2})
        self.assertEqual(doc["unexplained_by_area"], {"other": 2})

    def test_one_unexplained_file_beats_any_number_of_explained_ones(self):
        legacy, shadow = build_site(), build_site()
        shadow["person/I9003.json"] = dumps({"mergedInto": "I9001"})
        edit(shadow, PERSON1, lambda d: d.update(displayName="Test Person Uno"))
        code, doc = report(legacy, shadow)
        self.assertEqual((code, doc["explained"], doc["unexplained"]), (20, 1, 1))

    def test_a_file_with_one_explained_and_one_unexplained_change_is_unexplained(self):
        legacy, shadow = build_site(), build_site()
        edit(legacy, PLACE_CITY, lambda d: d.update(latitude="47.60621"))
        edit(shadow, PLACE_CITY, lambda d: d.update(latitude="47.61", displayName="Testtown"))
        code, doc = report(legacy, shadow)
        self.assertEqual((code, doc["explained"], doc["unexplained"]), (20, 0, 1))

    def test_a_byte_only_difference_and_a_broken_json_file(self):
        legacy, shadow = build_site(), build_site()
        shadow[NOTE] = json.dumps(load(shadow, NOTE)).encode("utf-8")      # same JSON, other bytes
        shadow[EVENT_BIRTH] = b"{ this is not json: Test Person Secret"
        code, doc = report(legacy, shadow)
        self.assertEqual((code, doc["unexplained_by_field"]), (20, {"bad_json": 1, "bytes_only": 1}))

    def test_an_index_entry_added_or_removed_is_unexplained(self):
        legacy, shadow = build_site(), build_site()
        edit(shadow, "person/index.json", lambda d: (d["people"].pop(), d.update(count=1)))
        edit(shadow, "media/index.json", lambda d: d.append({"grampsId": "O9009", "handle": hid("O9009"), "size": 1}))
        code, doc = report(legacy, shadow)
        self.assertEqual(code, 20)
        self.assertEqual(doc["unexplained_by_field"], {"entry_added": 1, "entry_removed": 1})
        self.assertEqual(doc["unexplained_by_area"], {"index": 2})


# ---- exit codes -------------------------------------------------------------------------------------------------------

class ExitCodes(unittest.TestCase):
    def test_empty_or_missing_shadow_is_69(self):
        site = build_site()
        for shadow in (None, {}, {"person/index.html": b"<html>", "media/%s.jpg" % hid("O9001"): b"x"}):
            code, cap = run_cli(site, shadow)
            self.assertEqual(code, 69, shadow)
            self.assertEqual(cap.out.getvalue(), "")
            self.assertRegex(cap.err.getvalue(), r"^hfy-parity: shadow_(missing|empty)\n$")

    def test_empty_or_missing_legacy_is_78(self):
        site = build_site()
        for legacy in (None, {}, {"media/%s.jpg" % hid("O9001"): b"x", "person/index.html": b"<html>"}):
            code, cap = run_cli(legacy, site)
            self.assertEqual(code, 78, legacy)
            self.assertRegex(cap.err.getvalue(), r"^hfy-parity: legacy_(missing|empty)\n$")

    def test_legacy_is_checked_before_the_shadow_is_fetched(self):
        runner = mock.Mock()
        code, cap = run_cli({}, build_site(), run=runner)
        self.assertEqual(code, 78)
        code, cap = run_cli(None, None)
        self.assertEqual(code, 78)

    def test_usage_errors_are_64_and_echo_nothing(self):
        for args in ([], ["--legacy", "Test Person Secret"], ["--bogus", "Test Person Secret"],
                     ["--legacy", "a", "--shadow", "b", "--extra", "Test Person Secret"]):
            cap = Capture()
            code = cli.main(args, out=cap.out, err=cap.err)
            self.assertEqual(code, 64, args)
            self.assertNotIn("Secret", cap.everything)
            self.assertIn("usage_error", cap.err.getvalue())
            self.assertEqual(cap.out.getvalue(), "")

    def test_an_internal_error_prints_the_class_only(self):
        site = build_site()
        with mock.patch.object(compare_mod, "compare", side_effect=ValueError("I9001 Test Person One person/I9001.json")):
            code, cap = run_cli(site, copy.deepcopy(site))
        self.assertEqual(code, 70)
        self.assertEqual(cap.err.getvalue(), "hfy-parity: internal_error (ValueError)\n")
        self.assertNotIn("I9001", cap.everything)

    def test_the_command_line_entry_point_end_to_end(self):
        legacy, shadow = build_site(), build_site()
        shadow["person/I9003.json"] = dumps({"mergedInto": "I9001"})
        with tempfile.TemporaryDirectory() as tmp:
            for name, site in (("legacy", legacy), ("shadow", shadow)):
                os.makedirs(os.path.join(tmp, name))
                write_tree(os.path.join(tmp, name), site)
            done = subprocess.run([sys.executable, "-I", BIN, "--legacy", os.path.join(tmp, "legacy"),
                                   "--shadow", os.path.join(tmp, "shadow")], capture_output=True, text=True)
        self.assertEqual(done.returncode, 10, done.stderr)
        self.assertIn("verdict=explained", done.stdout.splitlines()[0])
        self.assertIn("merged-person-stub", done.stdout)
        self.assertEqual(done.stderr, "")
        self.assertTrue(os.access(BIN, os.X_OK))


# ---- nothing identifying leaves the process ---------------------------------------------------------------------------

def secrets_of(*sites):
    """Every key, file name, Gramps ID, handle, name and text in the synthetic trees: none may appear in any output."""
    found = set()

    def walk(value):
        if isinstance(value, dict):
            for k, v in value.items():
                found.add(k) if k not in compare_mod.FIELD_VOCABULARY else None
                walk(v)
        elif isinstance(value, list):
            for v in value:
                walk(v)
        elif isinstance(value, str) and len(value) >= 3:
            found.add(value)

    for site in sites:
        for key, data in site.items():
            found.add(key)
            found.add(key.rsplit("/", 1)[-1])
            found.add(key.rsplit("/", 1)[-1].rsplit(".", 1)[0])
            try:
                walk(json.loads(data.decode("utf-8")))
            except ValueError:
                pass
    # words that are part of the report's own vocabulary are not values
    vocabulary = set(rules.RULES) | set(rules.NORMALISED) | set(compare_mod.AREAS) | set(compare_mod.FIELD_VOCABULARY)
    return {s for s in found if s not in vocabulary and not s.isdigit()}


class NoLeaks(unittest.TestCase):
    def scenarios(self):
        base = build_site()
        a = copy.deepcopy(base)
        # explained: an excluded place, a stub, a note, a coordinate
        b = copy.deepcopy(base)
        del b[PLACE_STREET]
        edit(b, "place/index.json", lambda d: d.__setitem__(slice(None), [e for e in d if e["grampsId"] != "P9002"]))
        b["person/I9003.json"] = dumps({"mergedInto": "I9001"})
        edit(b, NOTE, lambda d: d.update(raw="Test note text Secret"))
        # unexplained: a name, a key each way, a broken file, an unowned key, a byte-only change
        c = copy.deepcopy(base)
        edit(c, PERSON1, lambda d: d.update(displayName="Test Person Secret Name"))
        c["person/I9006.json"] = dumps({"displayName": "Test Person Six"})
        del c[PLACE_HOME]
        c[EVENT_BIRTH] = b"Test Person Secret {not json"
        c["media/%s.jpg" % hid("O9001")] = b"x"
        c[NOTE] = json.dumps(load(base, NOTE)).encode("utf-8")
        legacy_extra = copy.deepcopy(base)
        legacy_extra["media/%s.jpg" % hid("O9001")] = b"binary"
        legacy_extra["media/tree_I9001.svg"] = b"<svg/>"
        return [(base, a), (base, b), (base, c), (legacy_extra, c), (base, None), (None, base), (base, {})]

    def test_no_key_id_name_or_value_appears_in_stdout_stderr_or_logs(self):
        for legacy, shadow in self.scenarios():
            sites = [s for s in (legacy, shadow) if s]
            secrets = secrets_of(*sites)
            for extra in ([], ["--json"]):
                code, cap = run_cli(legacy, shadow, extra)
                text = cap.everything.replace(cap.tmp, "<tmp>")
                for secret in secrets:
                    self.assertNotIn(secret, text, "%r leaked (exit %s)" % (secret[:6], code))
                self.assertNotIn(cap.tmp, cap.everything)
                self.assertEqual(cap.logs, [])

    def test_the_report_vocabulary_is_closed(self):
        _, cap = run_cli(*self.scenarios()[2], ["--json"])
        doc = json.loads(cap.out.getvalue())
        allowed_fields = compare_mod.FIELD_VOCABULARY | set(compare_mod.CODE_WORDS)
        self.assertLessEqual(set(doc["unexplained_by_field"]), allowed_fields)
        self.assertLessEqual(set(doc["unexplained_by_area"]), set(compare_mod.AREAS))
        self.assertLessEqual(set(doc["rules"]), set(rules.RULES))
        self.assertLessEqual(set(doc["not_compared"]), set(rules.NOT_COMPARED))

        def numbers_only(value, top):
            if isinstance(value, dict):
                for k, v in value.items():
                    numbers_only(v, top or k)
            else:
                self.assertTrue(isinstance(value, (int, str)), top)
                if isinstance(value, str):
                    self.assertIn(top, ("verdict",))
        numbers_only({k: v for k, v in doc.items()}, None)


# ---- the s3 path ------------------------------------------------------------------------------------------------------

class FakeAws:
    """Stands in for subprocess.run: records the command line, 'downloads' a site into the destination folder."""

    def __init__(self, site=None, returncode=0, stderr=b"", raises=None):
        self.site, self.returncode, self.stderr, self.raises = site, returncode, stderr, raises
        self.calls, self.dests, self.dest_existed = [], [], []

    def __call__(self, argv, **kwargs):
        self.calls.append(list(argv))
        self.dests.append(argv[4])
        if self.raises:
            raise self.raises
        if self.site:
            write_tree(argv[4], self.site)
        return subprocess.CompletedProcess(argv, self.returncode, b"", self.stderr)


PREFIX = "s3://test-sync-bucket/render-shadow/"


class S3Path(unittest.TestCase):
    def test_only_a_download_is_run_and_the_temp_folder_is_removed(self):
        legacy = build_site()
        shadow = copy.deepcopy(legacy)
        shadow["person/I9003.json"] = dumps({"mergedInto": "I9001"})
        fake = FakeAws(shadow)
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "legacy"))
            write_tree(os.path.join(tmp, "legacy"), legacy)
            cap = Capture()
            code = cli.main(["--legacy", os.path.join(tmp, "legacy"), "--shadow", PREFIX], run=fake, out=cap.out, err=cap.err)
        self.assertEqual(code, 10)
        self.assertEqual(len(fake.calls), 1)
        argv = fake.calls[0]
        self.assertEqual(argv[:4], ["aws", "s3", "sync", PREFIX])
        self.assertFalse(argv[4].startswith("s3://"))
        self.assertEqual(argv[5:], ["--only-show-errors"])
        self.assertNotIn("--delete", argv)
        for verb in ("cp", "mv", "rm", "rb", "mb", "put-object", "delete-object", "s3api"):
            self.assertNotIn(verb, argv)
        self.assertFalse(os.path.exists(fake.dests[0]), "the temp folder must be gone")
        self.assertNotIn(fake.dests[0], cap.out.getvalue() + cap.err.getvalue())

    def test_a_prefix_without_a_trailing_slash_is_normalised(self):
        self.assertEqual(source.normalise_prefix("s3://test-sync-bucket/render-shadow"), PREFIX)
        self.assertEqual(source.normalise_prefix("s3://test-sync-bucket/a/b/render-shadow/"), "s3://test-sync-bucket/a/b/render-shadow/")

    def test_only_a_render_shadow_prefix_is_accepted_and_nothing_runs_otherwise(self):
        legacy = build_site()
        for bad in ("s3://test-sync-bucket/", "s3://test-sync-bucket/render/", "s3://test-sync-bucket/render-shadow-2/",
                    "s3://test-sync-bucket/render-shadow/person/", "s3://Bad_Bucket/render-shadow/", "s3:///render-shadow/",
                    "s3://test-sync-bucket/x y/render-shadow/"):
            fake = FakeAws(legacy)
            with tempfile.TemporaryDirectory() as tmp:
                write_tree(tmp, legacy)
                cap = Capture()
                code = cli.main(["--legacy", tmp, "--shadow", bad], run=fake, out=cap.out, err=cap.err)
            self.assertEqual(code, 64, bad)
            self.assertEqual(fake.calls, [], bad)
            self.assertNotIn("test-sync-bucket", cap.everything)

    def test_every_failure_removes_the_temp_folder_and_shows_nothing_of_aws(self):
        legacy = build_site()
        cases = [
            (FakeAws(returncode=255, stderr=b"An error occurred (AccessDenied) person/I9001.json Test Person One"), 69),
            (FakeAws(raises=FileNotFoundError("aws: command not found Test Person One")), 69),
            (FakeAws(raises=subprocess.TimeoutExpired("aws", 1)), 69),
            (FakeAws({"person/index.html": b"<html>"}), 69),                  # nothing the renderer owns
            (FakeAws(copy.deepcopy(legacy)), 0),
        ]
        for fake, expected in cases:
            with tempfile.TemporaryDirectory() as tmp:
                write_tree(tmp, legacy)
                cap = Capture()
                code = cli.main(["--legacy", tmp, "--shadow", PREFIX], run=fake, out=cap.out, err=cap.err)
            self.assertEqual(code, expected)
            self.assertFalse(os.path.exists(fake.dests[0]))
            for secret in ("AccessDenied", "I9001", "Test Person", "command not found", fake.dests[0]):
                self.assertNotIn(secret, cap.everything)

    def test_the_temp_folder_is_removed_when_the_comparison_raises(self):
        legacy = build_site()
        fake = FakeAws(copy.deepcopy(legacy))
        with tempfile.TemporaryDirectory() as tmp:
            write_tree(tmp, legacy)
            cap = Capture()
            with mock.patch.object(compare_mod, "compare", side_effect=RuntimeError("I9001")):
                code = cli.main(["--legacy", tmp, "--shadow", PREFIX], run=fake, out=cap.out, err=cap.err)
        self.assertEqual(code, 70)
        self.assertFalse(os.path.exists(fake.dests[0]))
        self.assertNotIn("I9001", cap.everything)

    def test_the_temp_folder_is_removed_on_an_interrupt(self):
        legacy = build_site()
        fake = FakeAws(copy.deepcopy(legacy))
        with tempfile.TemporaryDirectory() as tmp:
            write_tree(tmp, legacy)
            with mock.patch.object(compare_mod, "compare", side_effect=KeyboardInterrupt()):
                with self.assertRaises(KeyboardInterrupt):
                    cli.main(["--legacy", tmp, "--shadow", PREFIX], run=fake, out=io.StringIO(), err=io.StringIO())
        self.assertFalse(os.path.exists(fake.dests[0]))

    def test_assert_read_only_refuses_anything_but_a_download(self):
        good = source.sync_command(PREFIX, "/tmp/x")
        source.assert_read_only(good)
        bad = [
            ["aws", "s3", "sync", "/tmp/x", PREFIX],                           # an upload
            ["aws", "s3", "sync", PREFIX, "s3://other/x/"],                    # a copy between buckets
            good + ["--delete"],
            good + ["--exact-timestamps"],
            ["aws", "s3", "cp", PREFIX, "/tmp/x", "--recursive"],
            ["aws", "s3", "rm", PREFIX, "--recursive"],
            ["aws", "s3api", "put-object", "--bucket", "b"],
            ["aws", "s3", "sync", "/tmp/a", "/tmp/b"],
            [],
        ]
        for argv in bad:
            with self.assertRaises(source.ShadowUnreachable, msg=argv):
                source.assert_read_only(argv)

    def test_the_module_issues_no_other_verb(self):
        text = ""
        for name in ("source.py", "cli.py"):
            with open(os.path.join(GRAMPS, "hfyparity", name), encoding="utf-8") as fh:
                text += fh.read()
        for word in ("--delete\"", "put-object", "delete-object", "\"rm\"", "\"mv\"", "\"cp\"", "boto3", "shell=True"):
            self.assertNotIn(word, text.replace("`--delete`", ""), word)


# ---- the rules agree with the rest of the repository -----------------------------------------------------------------

class Agreement(unittest.TestCase):
    def test_the_policy_lists_come_from_redaction_v1(self):
        policy = rules.load_policy()
        self.assertEqual(policy.excluded_place_codes, frozenset({7, 18, 19, 20}))
        self.assertEqual(policy.held_mimes, frozenset({"application/pdf"}))
        self.assertEqual(policy.coordinate_decimals, 2)
        self.assertIn(12, policy.birth_codes)

    def test_the_excluded_place_rule_agrees_with_the_renderer(self):
        sys.path.insert(0, HERE)
        from hfygramps.render.places import is_home_like_place
        policy = rules.load_policy()
        strings = ["", "City", "Landmark", "Summer Home", "Farmhouse", "Charlotte", "Apt 4", "Lot", "Town Hall", "Street"]
        for code in [-1, 0, 1, 4, 7, 11, 18, 19, 20, 21, 99]:
            for string in strings:
                place = {"place_type": {"value": code, "string": string}}
                self.assertEqual(policy.place_excluded({"code": code, "string": string}), is_home_like_place(place),
                                 (code, string))

    def test_the_fixture_golden_is_explained_exactly_as_the_committed_delta_list(self):
        import render_support as rs
        legacy, render = rs.legacy_golden(), rs.rendered()
        result = compare_mod.compare(legacy, render, rules.load_policy())
        committed = rs.committed_deltas()
        self.assertEqual(result["unexplained"], 0)
        self.assertEqual(result["verdict"], "explained")
        self.assertEqual(result["classes"]["only_in_legacy"]["explained"], len(committed["only_in_legacy"]))
        self.assertEqual(result["classes"]["changed"]["explained"], len(committed["changed"]))
        self.assertEqual(result["classes"]["only_in_render"], {"explained": 0, "unexplained": 0})
        self.assertEqual(list(result["rules"]), ["excluded-place"])
        self.assertEqual(result["normalised"], {})
        self.assertGreater(result["files"]["identical"], 80)


class Docs(unittest.TestCase):
    def test_the_how_to_names_every_rule_exit_code_and_the_command(self):
        with open(DOC, encoding="utf-8") as fh:
            text = fh.read()
        for rule in list(rules.RULES) + list(rules.NORMALISED):
            self.assertIn("`%s`" % rule, text, rule)
        for code in (0, 10, 20, 64, 69, 70, 78):
            self.assertRegex(text, r"\|\s*`?%d`?\s*\|" % code)
        self.assertIn("AWS_PROFILE=product-lead", text)
        self.assertIn("gramps/bin/hfy-parity", text)
        self.assertIn("s3://<sync-bucket>/render-shadow/", text)

    def test_the_how_to_gives_the_exact_expect_holds_command_and_where_the_count_comes_from(self):
        with open(DOC, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("AWS_PROFILE=product-lead gramps/bin/hfy-parity \\\n  --legacy <project>/workspace-local/harrisonfamily-frontend \\\n"
                      "  --shadow s3://<sync-bucket>/render-shadow/ \\\n  --expect-holds <n>", text)
        self.assertIn("gramps/bin/hfy-sync check --json", text)
        self.assertIn("counts.holds", text)
        self.assertIn("status.json", text)
        self.assertNotRegex(text, r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}")      # no email address

    def test_the_how_to_gives_the_baseline_unhydrated_command_and_names_only_real_add_on_counts(self):
        import re
        from hfygramps.addon import status
        with open(DOC, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("AWS_PROFILE=product-lead gramps/bin/hfy-parity \\\n  --legacy <project>/workspace-local/harrisonfamily-frontend \\\n"
                      "  --shadow s3://<sync-bucket>/render-shadow/ \\\n  --expect-baseline-unhydrated <n>", text)
        self.assertIn("media whose baseline was captured before the file was available: allowed <n>, media explained <k>", text)
        self.assertIn("`baseline_unhydrated`", text)
        named = re.search(r"\(its `counts` are (.*?)\)", text, re.S)
        self.assertIsNotNone(named)
        self.assertEqual(set(re.findall(r"`([a-z_]+)`", named.group(1))), set(status.zero_counts()), "the page lists the add-on's counts as they are")
        self.assertNotIn(compare_mod.EMPTY_SHA256, text)
        for word in ("api/src/sync/media.js", "media/<handle>.jpeg", "media/<handle>.jpg", "`person/index.json`", "The JPEG key spelling"):
            self.assertIn(word, text, word)


if __name__ == "__main__":
    unittest.main()
