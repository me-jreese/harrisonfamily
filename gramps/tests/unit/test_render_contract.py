"""render-core-port: the D-02 contract, asserted structurally on the rendered P(synthetic-fixture-tree) (HFY-TSK-229, AC3, 5, 6, 7).

Notes from text.string / text.tags, typed event labels, mediaGallery[].region and .tags[], media/<handle>.json regions[],
family type, frel / mrel, family events with role, place type {code, string}, no sourcePath anywhere; no sortValue key and no
date.text with a day or month; tags[] carries MediaRef notes and citation titles; and the golden note vectors render escaped
or dropped. Standard library only. Run: python3 -m unittest discover gramps/tests/unit
"""

import json
import re
import unittest

import render_support as rs
from hfygramps.render import text_scan


def walk(value, path=()):
    """Yield (path, key, value) for every dict entry anywhere in a parsed JSON document."""
    if isinstance(value, dict):
        for key, child in value.items():
            yield path, key, child
            yield from walk(child, path + (key,))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk(child, path + (index,))


def note_html(gramps_id):
    return rs.render_json("note/%s.json" % rs.by_gramps_id("Note")[gramps_id]["handle"])["html"]


class Notes(unittest.TestCase):
    """AC3: notes come from text.string / text.tags, with the _string fallback; bold, size and colour cases."""

    def test_bold_italic_and_link_tags_render(self):
        self.assertEqual(
            note_html("N0001"),
            '<p><strong>Bold start</strong>, <em>italic middle</em>, <a href="https://notes.example.org/page" '
            'rel="noopener noreferrer nofollow" target="_blank">link end</a>.</p>')

    def test_the_underscore_shape_is_the_fallback(self):
        self.assertEqual(note_html("N9007"), "<p><strong>Legacy</strong> shape text with bold</p>")
        raw = rs.render_json("note/%s.json" % rs.by_gramps_id("Note")["N9007"]["handle"])["raw"]
        self.assertEqual(raw, "Legacy shape text with bold")

    def test_size_classes_and_an_unusable_size(self):
        self.assertEqual(
            note_html("N9006"),
            '<p><span class="note-size-sm">small</span> <span class="note-size-md">medium</span> '
            '<span class="note-size-lg">large</span> huge</p>')

    def test_colours_and_highlights(self):
        self.assertEqual(
            note_html("N9005"),
            '<p>Red words <span class="note-color" style="color: #a1b2c3;">and </span>b'
            '<span class="note-highlight" style="background-color: #ff0;">lue words</span></p>')

    def test_paragraphs_and_breaks(self):
        self.assertEqual(note_html("N9008"), "<p>First paragraph.</p><p>Second paragraph<br />with a break.<br />Third.</p>")

    def test_a_note_file_has_exactly_handle_id_raw_and_html(self):
        doc = rs.render_json("note/%s.json" % rs.by_gramps_id("Note")["N0001"]["handle"])
        self.assertEqual(set(doc), {"handle", "grampsId", "raw", "html"})
        self.assertEqual(doc["raw"], "Bold start, italic middle, link end.")


class GoldenNoteVectors(unittest.TestCase):
    """AC7: <script>, <img onerror>, overlapping tag ranges, a javascript: LINK, a non-hex colour: escaped or dropped."""

    def test_script_is_escaped(self):
        self.assertEqual(note_html("N9001"), "<p>Hello &lt;script&gt;alert(1)&lt;/script&gt; world</p>")

    def test_img_onerror_is_escaped(self):
        html = note_html("N9002")
        self.assertEqual(html, "<p>Look &lt;img src=x onerror=alert(2)&gt; here &amp; &quot;there&quot;</p>")
        self.assertNotIn("<img", html)

    def test_overlapping_tag_ranges_are_split_into_well_formed_markup(self):
        html = note_html("N9003")
        self.assertEqual(
            html,
            "<p><strong>Alpha </strong><strong><em>be</em></strong><strong><em><u>ta</u></em></strong><em><u> g</u></em>"
            "<em>amma</em> del<u>ta epsilo</u>n</p>")
        for tag in ("strong", "em", "u"):
            self.assertEqual(html.count("<%s>" % tag), html.count("</%s>" % tag))

    def test_a_javascript_link_is_dropped_and_an_https_link_kept(self):
        html = note_html("N9004")
        self.assertNotIn("javascript", html)
        self.assertEqual(html.count("<a "), 1)
        self.assertIn('<a href="https://notes.example.org/ok" rel="noopener noreferrer nofollow" target="_blank">here</a>', html)

    def test_a_non_hex_colour_is_dropped(self):
        html = note_html("N9005")
        self.assertNotIn("red", html.replace("Red", ""))
        self.assertNotIn("color: red", html)

    def test_non_ascii_text_is_kept_and_entities_are_escaped(self):
        self.assertEqual(note_html("N9009"), "<p>Café über &amp; &lt;b&gt;bold&lt;/b&gt; – done</p>")

    def test_no_note_carries_raw_markup_outside_the_allowed_tags(self):
        allowed = re.compile(r"</?(?:p|strong|em|u|s|sup|sub|a|span|br)\b")
        for key, data in rs.rendered().items():
            if not key.startswith("note/"):
                continue
            html = json.loads(data)["html"]
            for tag in re.findall(r"</?[a-zA-Z][^>]*>", html):
                self.assertRegex(tag, allowed, key)
            self.assertNotRegex(html, r"(?i)on\w+\s*=\s*[^&]*>|<script|javascript:")


class EventsAndPlaces(unittest.TestCase):
    def test_person_event_labels_are_the_type_labels(self):
        labels = [e["label"] for e in rs.person("I9001")["events"]]
        self.assertEqual(labels, ["Education", "Residence", "Birth", "Residence", "Fixture Gathering", "Event", "Death"])

    def test_event_types_are_code_and_english_string_and_custom_types_use_their_own_string(self):
        by_label = {e["label"]: e for e in rs.person("I9001")["events"]}
        self.assertEqual(by_label["Birth"]["type"], {"code": 12, "string": "Birth"})
        self.assertEqual(by_label["Death"]["type"], {"code": 13, "string": "Death"})
        self.assertEqual(by_label["Fixture Gathering"]["type"], {"code": 0, "string": "Fixture Gathering"})
        self.assertEqual(by_label["Event"]["type"], {"code": None, "string": None})  # typeless: index-based fallback label

    def test_a_custom_type_named_like_a_standard_one_stays_custom(self):
        # the tree's custom event type "Geburt" is a custom string, not a Birth
        labels = {json.loads(v)["label"] for k, v in rs.rendered().items() if k.startswith("event/")}
        self.assertIn("Geburt", labels)
        geburt = next(json.loads(v) for k, v in rs.rendered().items() if k.startswith("event/") and json.loads(v)["label"] == "Geburt")
        self.assertEqual(geburt["type"], {"code": 0, "string": "Geburt"})

    def test_event_files_have_no_role_and_family_events_do(self):
        for key, data in rs.rendered().items():
            if key.startswith("event/"):
                self.assertNotIn("role", json.loads(data), key)

    def test_place_type_is_code_and_string(self):
        by_id = rs.by_gramps_id("Place")
        expected = {"P0001": (1, "Country"), "P0002": (4, "City"), "P0005": (6, "Locality"), "P9005": (0, "Landmark")}
        for gid, (code, text) in expected.items():
            doc = rs.render_json("place/%s.json" % by_id[gid]["handle"])
            self.assertEqual(doc["type"], {"code": code, "string": text}, gid)

    def test_street_level_and_private_places_are_not_published_or_named(self):
        by_id = rs.by_gramps_id("Place")
        raw_ids = {o["gramps_id"]: o["handle"] for o in rs.raw_tree() if o["_class"] == "Place"}
        keys = set(rs.rendered())
        blob = b"".join(rs.rendered().values()).decode("utf-8")
        for gid in ("P0003", "P0004", "P0006", "P0007", "P0010", "P9003", "P9004", "P0008"):
            self.assertNotIn("place/%s.json" % raw_ids[gid], keys, gid)
            self.assertNotIn(raw_ids[gid], blob, gid)
        self.assertIn("P0002", by_id)


class Families(unittest.TestCase):
    def test_family_type_frel_mrel_and_events_with_role(self):
        doc = rs.render_json("family/%s.json" % rs.by_gramps_id("Family")["F9001"]["handle"])
        self.assertEqual(doc["type"], {"code": 2, "string": "Civil Union"})
        self.assertEqual([(c["grampsId"], c["frel"], c["mrel"]) for c in doc["children"]], [
            ("I9003", {"code": 2, "string": "Adopted"}, {"code": 5, "string": "Foster"}),
            ("I9004", {"code": 7, "string": "Fixture ward"}, {"code": 1, "string": "Birth"}),
        ])
        self.assertEqual([(e["label"], e["role"]) for e in doc["events"]], [
            ("Marriage", {"code": 8, "string": "Family"}), ("Fixture Ceremony", {"code": 0, "string": "Fixture Role"})])

    def test_a_custom_family_type_and_every_child_relation_in_the_tree(self):
        fam = rs.render_json("family/%s.json" % rs.by_gramps_id("Family")["F0005"]["handle"])
        self.assertEqual(fam["type"], {"code": 4, "string": "Fixture partnership"})
        self.assertEqual([(c["frel"], c["mrel"]) for c in fam["children"]],
                         [({"code": 0, "string": "None"}, {"code": 0, "string": "None"})])  # the held child is not listed
        docs = [json.loads(v) for k, v in rs.rendered().items() if k.startswith("family/")]
        self.assertEqual({d["type"]["code"] for d in docs}, {0, 1, 2, 3, 4})
        self.assertEqual({c["frel"]["code"] for d in docs for c in d["children"]}, set(range(8)))
        self.assertEqual({c["mrel"]["code"] for d in docs for c in d["children"]}, set(range(8)))

    def test_family_events_are_on_the_person_pages_too(self):
        tree = rs.person("I9001")["familyTree"]
        self.assertEqual(tree["spouseFamilies"][0]["events"][0]["role"], {"code": 8, "string": "Family"})
        self.assertEqual(rs.person("I9003")["familyTree"]["parentFamilies"][0]["type"], {"code": 2, "string": "Civil Union"})

    def test_a_held_or_private_parent_and_a_private_child_ref_are_not_in_the_family(self):
        families = rs.by_gramps_id("Family")
        f7 = rs.render_json("family/%s.json" % families["F0007"]["handle"])      # father held
        f8 = rs.render_json("family/%s.json" % families["F0008"]["handle"])      # mother private
        f1 = rs.render_json("family/%s.json" % families["F0001"]["handle"])      # one private ChildRef, one private EventRef
        self.assertIsNone(f7["father"])
        self.assertIsNone(f8["mother"])
        self.assertEqual([c["grampsId"] for c in f1["children"]], ["I0003", "I0004", "I0005", "I0006", "I0007"])
        raw = {o["gramps_id"]: o["handle"] for o in rs.raw_tree() if o["_class"] == "Person" and "gramps_id" in o}
        blob = json.dumps([f7, f8, f1])
        for gid in ("I0010", "I0011"):
            self.assertNotIn(raw[gid], blob, gid)


class PhotoRegionsAndTags(unittest.TestCase):
    def setUp(self):
        self.quill = rs.person("I9001")
        self.photo = self.quill["mediaGallery"][0]

    def test_gallery_region_is_the_exact_rect_or_null(self):
        self.assertEqual(self.photo["region"], [5, 5, 45, 95])
        self.assertEqual(self.quill["primaryPhoto"]["region"], [5, 5, 45, 95])
        # the tree: a [0,0,100,100] rect is kept as stored (the crop rule is the consumer's), a float rect has no region
        self.assertEqual(rs.person("I0014")["mediaGallery"][0]["region"], [0, 0, 100, 100])
        self.assertIsNone(rs.person("I0015")["mediaGallery"][0]["region"])         # a float rect is not an integer rect
        self.assertIsNone(rs.person("I0015")["mediaGallery"][1]["region"])         # no rect at all

    def test_a_dangling_media_ref_is_a_missing_stub_with_its_region(self):
        stub = self.quill["mediaGallery"][1]
        self.assertEqual(stub, {"handle": "ghost-media-handle-0001", "title": None, "missing": True, "region": [1, 2, 3, 4],
                                "tags": [], "checksum": None, "size": None})

    def test_tags_list_everyone_tagged_in_the_photo_in_every_gallery(self):
        for gid in ("I9001", "I9002"):
            tags = rs.person(gid)["mediaGallery"][0]["tags"]
            self.assertEqual([t["grampsId"] for t in tags], ["I9001", "I9002"])
            self.assertTrue(all(t["source"] == "gramps" for t in tags))
            self.assertEqual({t["grampsId"]: t["isPrimary"] for t in tags}, {"I9001": True, "I9002": True})

    def test_two_tags_of_one_person_in_one_photo_are_two_tags(self):
        tags = [t for t in rs.person("I0013")["mediaGallery"][0]["tags"] if t["grampsId"] == "I0013"]
        self.assertEqual(sorted(t["rect"] for t in tags), [[10, 10, 40, 40], [50, 10, 90, 40]])
        self.assertEqual([g["region"] for g in rs.person("I0013")["mediaGallery"]], [[10, 10, 40, 40], [50, 10, 90, 40]])

    def test_tags_carry_mediaref_notes_attributes_and_citation_titles(self):
        quill = self.photo["tags"][0]
        self.assertEqual([n["grampsId"] for n in quill["notes"]], ["N9101"])   # N9102 held (phone), N9103 private
        self.assertEqual(quill["notes"][0]["html"], "<p>Standing at the left of the porch.</p>")
        self.assertEqual(quill["attributes"], [{"type": "Description", "value": "Standing at left"},
                                               {"type": "Mood", "value": "Cheerful"}])  # AGE, private and phone-valued dropped
        self.assertEqual(quill["citations"], ["Fixture Photo Archive"])  # phone in a title, private citation, private source
        self.assertEqual(set(quill), {"grampsId", "name", "rect", "isPrimary", "attributes", "notes", "citations", "source"})

    def test_media_json_has_regions_for_each_tag(self):
        media = rs.by_gramps_id("Media")["O9001"]
        doc = rs.render_json("media/%s.json" % media["handle"])
        self.assertEqual(doc["s3Key"], "media/%s.jpg" % media["handle"])
        self.assertEqual([r["person"]["grampsId"] for r in doc["regions"]], ["I9001", "I9002"])
        first = doc["regions"][0]
        self.assertEqual(set(first), {"person", "rect", "attributes", "notes"})
        self.assertEqual(set(first["person"]), {"handle", "grampsId", "displayName"})
        self.assertEqual(first["person"]["displayName"], "Quill Notevector")
        self.assertEqual(first["rect"], [5, 5, 45, 95])
        self.assertEqual(first["notes"][0]["grampsId"], "N9101")
        self.assertEqual(set(doc), {"handle", "grampsId", "title", "mime", "s3Key", "regions", "missing", "checksum", "size"})

    def test_private_and_held_photo_objects_publish_nothing(self):
        blob = b"".join(rs.rendered().values()).decode("utf-8")
        raw = {o["gramps_id"]: o["handle"] for o in rs.raw_tree() if o["_class"] == "Media"}
        for gid in ("O0004", "O0005", "O0006"):
            self.assertNotIn(raw[gid], blob, gid)
        # the private person's own photo and the private MediaRef do not tag anyone
        tags = [t["grampsId"] for p in ("I0013",) for g in rs.person(p)["mediaGallery"] for t in g["tags"]]
        self.assertNotIn("I0010", tags)


class NoSourcePathNoSortvalNoDayOrMonth(unittest.TestCase):
    """AC3 (no sourcePath), AC5 (no sortValue, no day or month in date.text)."""

    def test_no_output_has_sourcepath_or_a_placeholder_image(self):
        for key, data in rs.rendered().items():
            text = data.decode("utf-8")
            self.assertNotIn("sourcePath", text, key)
            self.assertNotIn("placeholderImage", text, key)
            self.assertNotIn("placehold.co", text, key)

    def test_no_output_has_a_sortvalue_key(self):
        for key, data in rs.rendered().items():
            for _path, name, _value in walk(json.loads(data)):
                self.assertNotIn(name.lower(), ("sortvalue", "sortval"), key)
            self.assertNotRegex(data.decode("utf-8"), r'(?i)"sort_?val')

    def test_no_date_text_carries_a_day_or_month(self):
        sources = {o["handle"]: o for o in rs.p_fixture() if o["_class"] == "Event"}
        checked = dated = 0
        for key, data in rs.rendered().items():
            doc = json.loads(data)
            for path, name, value in walk(doc):
                if name != "date" or not isinstance(value, dict) or "year" not in value:
                    continue
                self.assertEqual(set(value), {"text", "year"}, key)
                self.assertFalse(text_scan.blocking_hits(value["text"] or ""), key)
                checked += 1
            if key.startswith("event/"):
                date = sources[doc["handle"]]["date"]["dateval"]
                if date[0] or date[1]:
                    dated += 1
                    self.assertEqual(doc["date"]["text"], "", key)
                    self.assertGreater(date[2], 0)
        self.assertGreater(checked, 40)
        self.assertGreater(dated, 15)

    def test_the_legacy_golden_has_the_same_properties(self):
        for key, data in rs.legacy_golden().items():
            self.assertNotIn("sourcePath", data.decode("utf-8"), key)
            self.assertNotRegex(data.decode("utf-8"), r'(?i)"sort_?val', key)


class WhatTheSiteLeavesOut(unittest.TestCase):
    def test_no_birth_day_or_month_appears_anywhere(self):
        # every full birth date in the tree, in the forms the site could print it
        blob = b"".join(rs.rendered().values()).decode("utf-8")
        for obj in rs.p_fixture():
            if obj["_class"] != "Event":
                continue
            day, month, year, _slash = obj["date"]["dateval"][:4]
            if day and month and year:
                self.assertNotIn("%04d-%02d-%02d" % (year, month, day), blob)
                self.assertNotIn("%d/%d/%04d" % (month, day, year), blob)

    def test_private_objects_and_their_handles_are_not_published(self):
        blob = b"".join(rs.rendered().values()).decode("utf-8") + "\n".join(rs.rendered())
        private = [o for o in rs.raw_tree() if o.get("private")]
        self.assertGreater(len(private), 10)
        for obj in private:
            self.assertNotIn(obj["handle"], blob, obj.get("gramps_id"))

    def test_contact_data_and_sensitive_attribute_values_are_not_published(self):
        blob = b"".join(rs.rendered().values()).decode("utf-8")
        for needle in ("555-01", "@example.org", "Call 555", "06:30", "Secret"):
            self.assertNotIn(needle, blob, needle)


if __name__ == "__main__":
    unittest.main()
