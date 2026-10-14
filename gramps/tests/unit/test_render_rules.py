"""render-core-port: the renderer's own rules and edge cases on small synthetic trees (HFY-TSK-229). Standard library only.

Street-level and home-like places, the text gate, a person without a Gramps ID, media blobs, reachability and the manifests.
Run: python3 -m unittest discover gramps/tests/unit
"""

import json
import os
import unittest

import render_support as rs
from hfygramps.render import places, policy, render, render_site
from hfygramps.render.policy import default_text_gate, open_text_gate

P = rs.parity
h = P.h


def doc(files, key):
    return json.loads(files[key])


def tiny(*extra, person_events=()):
    """A country, a city, a street, and one person with the given events, plus whatever else."""
    objs = [P._place("P1", "Country One", 1), P._place("P2", "City Two", 4, "P1"), P._place("P3", "Street Three", 7, "P2")]
    objs += list(extra)
    return objs


class HomeLikePlaces(unittest.TestCase):
    def test_which_place_types_are_excluded(self):
        def place(code, string=""):
            return {"place_type": {"_class": "PlaceType", "value": code, "string": string}}
        for code in (7, 18, 19, 20):
            self.assertTrue(places.is_home_like_place(place(code)), code)
        for code in (1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, -1):
            self.assertFalse(places.is_home_like_place(place(code)), code)
        for text in ("Home", "My House", "Residence", "Mailing Address", "Apartment 4", "Apt", "Parking Lot", "Hill Farm", "FARM"):
            self.assertTrue(places.is_home_like_place(place(0, text)), text)
        for text in ("Landmark", "Cemetery", "Church", ""):
            self.assertFalse(places.is_home_like_place(place(0, text)), text)
        self.assertTrue(places.is_home_like_place({"place_type": "Street"}))            # a type given by name
        self.assertTrue(places.is_home_like_place({"place_type": {"value": 99, "string": "Home office"}}))  # unknown code, own string

    def test_an_event_at_a_street_is_re_pointed_to_the_city_and_the_street_is_not_published(self):
        objs = tiny(
            P._event("E1", 42, 1950, 0, 0, "P3"),
            P._person("I1", "Ada", "Example", 0, [P._event_ref("E1")]),
        )
        files = render_site(objs)
        event = doc(files, "event/%s.json" % h("E1"))
        self.assertEqual((event["place"]["grampsId"], event["place"]["displayName"]), ("P2", "City Two"))
        self.assertNotIn("place/%s.json" % h("P3"), files)
        self.assertIn("place/%s.json" % h("P2"), files)
        self.assertEqual([e["grampsId"] for e in doc(files, "place/index.json")], ["P1", "P2"])
        self.assertNotIn(h("P3"), b"".join(files.values()).decode())

    def test_an_event_whose_chain_has_no_kept_ancestor_has_no_place(self):
        objs = [P._place("P1", "Old Farm", 18), P._event("E1", 42, 1950, 0, 0, "P1"),
                P._person("I1", "Ada", "Example", 0, [P._event_ref("E1")])]
        files = render_site(objs)
        self.assertIsNone(doc(files, "event/%s.json" % h("E1"))["place"])
        self.assertEqual(doc(files, "place/index.json"), [])

    def test_a_kept_place_under_an_excluded_one_is_re_pointed_too(self):
        objs = [P._place("P1", "Country One", 1), P._place("P2", "Big Building", 19, "P1"), P._place("P3", "Hall Room", 0, "P2", "Room"),
                P._event("E1", 0, 1950, 0, 0, "P3", "Gathering"), P._person("I1", "Ada", "Example", 0, [P._event_ref("E1")])]
        files = render_site(objs)
        room = doc(files, "place/%s.json" % h("P3"))
        self.assertEqual([p["grampsId"] for p in room["parents"]], ["P1"])
        self.assertNotIn("place/%s.json" % h("P2"), files)

    def test_a_cycle_of_excluded_places_ends_with_no_place(self):
        a, b = P._place("P1", "Home One", 18, "P2"), P._place("P2", "Home Two", 18, "P1")
        objs = [a, b, P._event("E1", 42, 1950, 0, 0, "P1"), P._person("I1", "Ada", "Example", 0, [P._event_ref("E1")])]
        files = render_site(objs)
        self.assertIsNone(doc(files, "event/%s.json" % h("E1"))["place"])

    def test_the_callers_objects_are_not_edited_by_the_exclusion(self):
        objs = tiny(P._event("E1", 42, 1950, 0, 0, "P3"), P._person("I1", "Ada", "Example", 0, [P._event_ref("E1")]))
        before = json.dumps(objs, sort_keys=True)
        render_site(objs)
        self.assertEqual(json.dumps(objs, sort_keys=True), before)


class TextGate(unittest.TestCase):
    def objects(self, *notes):
        return [P._person("I1", "Ada", "Example", 0, notes=[n["gramps_id"] for n in notes])] + list(notes)

    def test_the_default_gate_withholds_contact_data_and_day_precise_dates(self):
        ok = P._note("N1", "A quiet note about the garden.")
        phone = P._note("N2", "Call 555-0142 tonight.")
        mail = P._note("N3", "Write to someone@example.org soon.")
        date = P._note("N4", "The ledger lists 12/25/1960 here.")
        street = P._note("N5", "Lived at 100 Example Street once.")
        files = render_site(self.objects(ok, phone, mail, date, street))
        self.assertEqual([n["grampsId"] for n in doc(files, "person/I1.json")["notes"]], ["N1"])
        self.assertEqual([k for k in files if k.startswith("note/")], ["note/%s.json" % h("N1")])

    def test_the_report_counts_what_was_withheld_and_what_was_published(self):
        result = render(self.objects(P._note("N1", "Fine."), P._note("N2", "Call 555-0142 tonight.")))
        self.assertEqual((result.report.notes_published, result.report.notes_withheld), (1, 1))
        self.assertEqual(result.report.files["note"], 1)

    def test_a_caller_can_pass_its_own_gate(self):
        objs = self.objects(P._note("N1", "Call 555-0142 tonight."))
        self.assertEqual(len(doc(render_site(objs, text_gate=open_text_gate), "person/I1.json")["notes"]), 1)
        self.assertEqual(doc(render_site(objs, text_gate=lambda text: False), "person/I1.json")["notes"], [])

    def test_the_gate_passes_clean_text_and_blocks_each_kind_of_contact_or_date_data(self):
        self.assertTrue(default_text_gate(""))
        self.assertTrue(default_text_gate("Born in the spring of 1950 on the farm."))
        blocked = {
            "a birth date with a month and day": "Born March 3, 1950.",
            "a phone number": "Call 555-0142 tonight.",
            "an e-mail address": "Write to someone@example.org soon.",
            "a street address": "Lived at 100 Example Street once.",
            "a day-precise date": "The ledger lists 12/25/1960 here.",
            "a contact URL": "Message me at https://wa.me/15550142",
        }
        for what, text in blocked.items():
            self.assertFalse(default_text_gate(text), what)

    def test_a_private_note_is_never_published_even_with_an_open_gate(self):
        objs = self.objects(P._note("N1", "Fine.", private=True))
        files = render_site(objs, text_gate=open_text_gate)
        self.assertEqual(doc(files, "person/I1.json")["notes"], [])
        self.assertFalse([k for k in files if k.startswith("note/")])


def media_object(gid, desc):
    return {"_class": "Media", "attribute_list": [], "change": 0, "checksum": "", "citation_list": [], "date": P._date(),
            "desc": desc, "gramps_id": gid, "handle": h(gid), "mime": "image/png", "note_list": [], "path": "",
            "private": False, "tag_list": [], "thumb": None}


def url(path, desc="", code=0, private=False):
    return {"_class": "Url", "desc": desc, "path": path, "private": private,
            "type": {"_class": "UrlType", "value": code, "string": ""}}


class OtherFreeTextIsGated(unittest.TestCase):
    """Event.description, Media.desc, place URLs and note LINK values pass the same gate as notes (review of HFY-TSK-229)."""

    CONTACT_TEXT = "Lived at 12 Example Street, call 555-0142"

    def test_an_event_description_with_contact_data_is_dropped_everywhere_it_is_written(self):
        objs = [
            P._event("E1", 42, 1950, 0, 0, description=self.CONTACT_TEXT),
            P._event("E2", 42, 1951, 0, 0, description="Harvest festival"),
            P._person("I1", "Ada", "Example", 0, [P._event_ref("E1"), P._event_ref("E2")]),
        ]
        files = render_site(objs)
        self.assertIsNone(doc(files, "event/%s.json" % h("E1"))["description"])
        self.assertEqual(doc(files, "event/%s.json" % h("E2"))["description"], "Harvest festival")
        person = {e["grampsId"]: e for e in doc(files, "person/I1.json")["events"]}
        self.assertIsNone(person["E1"]["description"])
        self.assertEqual(person["E2"]["description"], "Harvest festival")
        self.assertNotIn(b"555-0142", b"".join(files.values()))
        self.assertEqual(doc(render_site(objs, text_gate=open_text_gate), "event/%s.json" % h("E1"))["description"],
                         self.CONTACT_TEXT)

    def test_a_family_event_description_is_gated(self):
        fam = {"_class": "Family", "attribute_list": [], "change": 0, "child_ref_list": [], "citation_list": [],
               "event_ref_list": [P._event_ref("E1")], "father_handle": h("I1"), "gramps_id": "F1", "handle": h("F1"),
               "lds_seal_list": [], "media_list": [], "mother_handle": "", "note_list": [], "private": False,
               "tag_list": [], "type": P._typed("FamilyRelType", 0)}
        objs = [fam, P._event("E1", 2, 1970, 0, 0, description="see 555-0142"),
                P._person("I1", "Ada", "Example", 0, families=["F1"])]
        files = render_site(objs)
        self.assertIsNone(doc(files, "family/%s.json" % h("F1"))["events"][0]["description"])

    def test_a_media_description_with_contact_data_falls_back_to_the_gramps_id(self):
        objs = [media_object("O1", "Call 555-0142 for prints"), media_object("O2", "Porch at dusk"),
                P._person("I1", "Ada", "Example", 0, media=[P._media_ref("O1", None), P._media_ref("O2", None)])]
        files = render_site(objs)
        self.assertEqual(doc(files, "media/%s.json" % h("O1"))["title"], "O1")
        self.assertEqual(doc(files, "media/%s.json" % h("O2"))["title"], "Porch at dusk")
        self.assertEqual([m["title"] for m in doc(files, "person/I1.json")["mediaGallery"]], ["O1", "Porch at dusk"])
        self.assertNotIn(b"555-0142", b"".join(files.values()))

    def test_place_urls_keep_a_plain_link_and_drop_contact_links(self):
        place = P._place("P1", "Exampleville", 4)
        place["urls"] = [
            url("https://example.org/history", "Local history"),
            url("mailto:someone@example.org"),
            url("https://example.org/page", "ask on 555-0142"),
            url("https://example.org/a?email=someone@example.org"),
            url("https://wa.me/15550142"),
            url("someone@example.org", code=1),
            url("https://example.org/private", private=True),
        ]
        objs = [place, P._event("E1", 42, 1950, 0, 0, "P1"),
                P._person("I1", "Ada", "Example", 0, [P._event_ref("E1")])]
        urls = doc(render_site(objs), "place/%s.json" % h("P1"))["urls"]
        self.assertEqual([u["path"] for u in urls], ["https://example.org/history"])

    def test_a_note_link_with_contact_data_or_credentials_becomes_plain_text(self):
        from hfygramps.render.note_tags import normalise_note_text
        gate = default_text_gate
        for href in ("https://user:secret@example.org/a", "https://example.org/a?email=someone@example.org",
                     "https://example.org/a?tel=555-0142", "https://example.org/a?phone=(555) 555-0142"):
            note = P._note("N1", "Click here", [P._tag(8, [[0, 5]], href)])
            html = normalise_note_text(note, gate)["html"]
            self.assertNotIn("<a ", html, href)
            self.assertEqual(html, "<p>Click here</p>", href)
        ok = P._note("N1", "Click here", [P._tag(8, [[0, 5]], "https://example.org/ok")])
        self.assertIn('<a href="https://example.org/ok"', normalise_note_text(ok, gate)["html"])

    def test_the_link_gate_reaches_the_published_note_files(self):
        note = P._note("N1", "Click here", [P._tag(8, [[0, 5]], "https://example.org/a?email=someone@example.org")])
        objs = [note, P._person("I1", "Ada", "Example", 0, notes=["N1"])]
        files = render_site(objs)
        self.assertNotIn(b"someone@example.org", b"".join(files.values()))
        self.assertEqual(doc(files, "note/%s.json" % h("N1"))["html"], "<p>Click here</p>")


class RuleSourceAgreement(unittest.TestCase):
    """The place-type and attribute lists in the renderer are an interim copy of redaction-v1.json (BRD2 D2-32)."""

    RULES = os.path.join(rs.GRAMPS, "redaction", "redaction-v1.json")

    def test_the_interim_copy_is_what_the_design_says(self):
        self.assertEqual(places.EXCLUDED_PLACE_TYPE_CODES, {7, 18, 19, 20})
        self.assertEqual(places.HOME_LIKE_RE.pattern, "house|home|residence|address|apartment|apt|lot|farm")
        self.assertEqual(policy.SENSITIVE_ATTRIBUTE_CODES, {3, 6, 10, 11, 12, 14})

    def test_the_match_is_the_specs_unanchored_one_so_it_over_excludes_and_never_under_excludes(self):
        def place(text):
            return {"place_type": {"_class": "PlaceType", "value": 0, "string": text}}
        for text in ("Homestead", "Farmhouse", "Charlotte", "Adaptation", "Allotment"):
            self.assertTrue(places.is_home_like_place(place(text)), text)
        for text in ("Cemetery", "Church", "Lake", "Parish"):
            self.assertFalse(places.is_home_like_place(place(text)), text)

    def test_redaction_v1_json_agrees_with_the_renderer_once_it_exists(self):
        if not os.path.exists(self.RULES):
            self.skipTest("gramps/redaction/redaction-v1.json is not in the tree yet (redaction-policy-v1); interim copy in use")
        with open(self.RULES, encoding="utf-8") as fh:
            document = json.load(fh)
        strings, numbers = set(), set()

        def walk(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    strings.add(str(key))
                    walk(item)
            elif isinstance(value, list):
                for item in value:
                    walk(item)
            elif isinstance(value, str):
                strings.add(value)
            elif isinstance(value, int) and not isinstance(value, bool):
                numbers.add(value)

        walk(document)
        # Exact comparison when the file has the shape of redaction-policy-v1's first draft; the looser checks below
        # still run if the shape changes.
        section = document.get("places") if isinstance(document, dict) else None
        if isinstance(section, dict) and "excludedTypes" in section:
            self.assertEqual({t["value"] for t in section["excludedTypes"]}, set(places.EXCLUDED_PLACE_TYPE_CODES))
            self.assertEqual(section["customHomeLike"]["pattern"], places.HOME_LIKE_RE.pattern)
        section = document.get("attributes") if isinstance(document, dict) else None
        if isinstance(section, dict) and "ageAndTime" in section:
            listed = {t["value"] for group in section.values() for t in group}
            self.assertEqual(listed, set(policy.SENSITIVE_ATTRIBUTE_CODES))
        pattern = places.HOME_LIKE_RE.pattern
        self.assertTrue(any(pattern in text for text in strings),
                        "redaction-v1.json holds no home-like place pattern equal to %r" % pattern)
        missing_places = places.EXCLUDED_PLACE_TYPE_CODES - numbers
        self.assertFalse(missing_places, "redaction-v1.json does not list place type codes %s" % sorted(missing_places))
        missing_attrs = policy.SENSITIVE_ATTRIBUTE_CODES - numbers
        self.assertFalse(missing_attrs, "redaction-v1.json does not list attribute codes %s" % sorted(missing_attrs))


class PeopleAndManifests(unittest.TestCase):
    def test_a_person_without_a_gramps_id_has_no_file_and_is_in_no_index(self):
        nameless = P._person("I1", "Ghost", "Example", 0)
        nameless["gramps_id"] = ""
        fine = P._person("I2", "Ada", "Example", 0)
        files = render_site([nameless, fine])
        self.assertEqual([k for k in files if k.startswith("person/") and "index" not in k], ["person/I2.json"])
        self.assertEqual([p["grampsId"] for p in doc(files, "person/index.json")["people"]], ["I2"])
        self.assertEqual([d["grampsId"] for d in doc(files, "person/search-index.json")["documents"]], ["I2"])
        self.assertEqual(render([nameless, fine]).report.persons_skipped_no_id, 1)

    def test_two_heads_with_one_gramps_id_render_the_first_handle(self):
        a, b = P._person("I1", "Ada", "Example", 0), P._person("I1", "Bea", "Example", 0)
        b["handle"] = "ffff" + b["handle"][4:]
        a["handle"] = "0000" + a["handle"][4:]
        self.assertEqual(doc(render_site([b, a]), "person/I1.json")["givenName"], "Ada")

    def test_empty_input_renders_two_empty_indexes_and_two_empty_manifests(self):
        files = render_site([])
        self.assertEqual(sorted(files), ["media/index.json", "person/index.json", "person/search-index.json", "place/index.json"])
        self.assertEqual(doc(files, "person/index.json")["count"], 0)
        self.assertEqual(files["place/index.json"], b"[]")

    def test_classes_the_site_does_not_render_are_ignored(self):
        junk = [{"_class": "Tag", "handle": "t1", "name": "x"}, {"_class": "Repository", "handle": "r1", "gramps_id": "R1"},
                {"handle": "z", "gramps_id": "Z1"}]
        self.assertEqual(sorted(render_site(junk)), sorted(render_site([])))

    def test_only_what_a_public_person_reaches_is_rendered(self):
        objs = [P._person("I1", "Ada", "Example", 0, [P._event_ref("E1")]), P._event("E1", 12, 1950, 0, 0),
                P._event("E2", 12, 1960, 0, 0), P._note("N2", "Nobody refers to this note.")]
        files = render_site(objs)
        self.assertIn("event/%s.json" % h("E1"), files)
        self.assertNotIn("event/%s.json" % h("E2"), files)
        self.assertNotIn("note/%s.json" % h("N2"), files)

    def test_a_private_person_and_what_only_they_reach_are_not_rendered(self):
        secret = P._person("I1", "Sam", "Example", 1, [P._event_ref("E1")])
        secret["private"] = True
        objs = [secret, P._event("E1", 12, 1950, 0, 0), P._person("I2", "Ada", "Example", 0)]
        files = render_site(objs)
        self.assertNotIn("person/I1.json", files)
        self.assertNotIn("event/%s.json" % h("E1"), files)
        self.assertNotIn(secret["handle"], b"".join(files.values()).decode())

    def test_manifests_list_places_and_media_by_gramps_id(self):
        objs = [P._place("P2", "Second", 4), P._place("P1", "First", 4), P._event("E1", 12, 1950, 0, 0, "P2"),
                P._event("E2", 12, 1951, 0, 0, "P1"), P._person("I1", "Ada", "Example", 0, [P._event_ref("E1"), P._event_ref("E2")])]
        self.assertEqual([e["grampsId"] for e in doc(render_site(objs), "place/index.json")], ["P1", "P2"])

    def test_the_person_manifest_and_search_documents(self):
        objs = [P._person("I2", "Zoe", "Zed", 0), P._person("I10", "Éva", "Ünder", 0, [P._event_ref("E1")], birth=0),
                P._event("E1", 12, 1950, 0, 0)]
        files = render_site(objs, generated_at="T")
        index = doc(files, "person/index.json")
        self.assertEqual(list(index), ["count", "generatedAt", "people"])
        # file-name order: "I10.json" sorts before "I2.json"
        self.assertEqual([p["grampsId"] for p in index["people"]], ["I10", "I2"])
        self.assertEqual(list(index["people"][0]), ["handle", "grampsId", "displayName", "givenName", "surname", "isLiving",
                                                    "birthYear", "deathYear", "lifespanSummary", "primaryPhoto"])
        docs = doc(files, "person/search-index.json")["documents"]
        self.assertEqual(docs[0], {"grampsId": "I10", "searchText": "éva ünder éva ünder i10 1950 1950–"})
        self.assertEqual(docs[1]["searchText"], "zoe zed zoe zed i2")
        # build_search_index.js writes raw UTF-8; the ETL's person files escape it
        self.assertIn("Éva Ünder".encode("utf-8"), files["person/index.json"])
        self.assertIn(b"\\u00c9va", files["person/I10.json"])
        self.assertTrue(files["person/index.json"].startswith(b'{\n  "count": 2,'))


class MediaBlobs(unittest.TestCase):
    def objects(self):
        media = {"_class": "Media", "attribute_list": [], "change": 0, "checksum": "", "citation_list": [], "date": P._date(),
                 "desc": "A photo", "gramps_id": "O1", "handle": h("O1"), "mime": "image/png", "note_list": [], "path": "",
                 "private": False, "tag_list": [], "thumb": None}
        return [media, P._person("I1", "Ada", "Example", 0, media=[P._media_ref("O1", None)])]

    def test_a_media_object_with_no_blob_info_is_missing(self):
        files = render_site(self.objects())
        media = doc(files, "media/%s.json" % h("O1"))
        self.assertEqual((media["missing"], media["checksum"], media["size"]), (True, None, None))
        self.assertEqual(media["s3Key"], "media/%s.png" % h("O1"))                   # no path: the extension comes from the mime type
        self.assertTrue(doc(files, "person/I1.json")["mediaGallery"][0]["missing"])

    def test_blob_info_and_an_extension_override_reach_the_media_and_person_files(self):
        info = {h("O1"): {"checksum": "ab" * 32, "size": 12, "ext": ".webp"}}
        files = render_site(self.objects(), media_files=info)
        media = doc(files, "media/%s.json" % h("O1"))
        self.assertEqual((media["missing"], media["checksum"], media["size"], media["s3Key"]),
                         (False, "ab" * 32, 12, "media/%s.webp" % h("O1")))
        item = doc(files, "person/I1.json")["mediaGallery"][0]
        self.assertEqual((item["s3Key"], item["checksum"], item["size"], item["missing"]), (media["s3Key"], "ab" * 32, 12, False))
        self.assertEqual(doc(files, "person/I1.json")["primaryPhoto"], item)
        self.assertEqual(doc(files, "person/index.json")["people"][0]["primaryPhoto"], media["s3Key"])

    def test_no_media_binary_is_ever_a_key(self):
        for key in rs.rendered():
            self.assertTrue(key.endswith(".json"), key)


if __name__ == "__main__":
    unittest.main()
