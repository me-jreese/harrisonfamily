"""render-core-port: byte parity of hfygramps.render with the live ETL on P(synthetic-fixture-tree) (HFY-TSK-229, AC2).

The golden under gramps/tests/fixtures/render/golden/legacy/ is what the patched live ETL (d02-etl-quick-fixes plus
d02-etl-media-regions) and build_search_index.js write for P(fixture); make_legacy_golden.py regenerates it on a worker
that has the live project (HFY_LEGACY_PROJECT). These tests need neither: they render P(fixture) and require every
file to be byte-identical to the golden except where expected-deltas.json lists the difference, pointer by pointer.

Standard library only. Run: python3 -m unittest discover gramps/tests/unit
"""

import json
import os
import unittest

import render_support as rs

deltas = rs.deltas


class Parity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.legacy = rs.legacy_golden()
        cls.render = rs.rendered()
        cls.doc = rs.committed_deltas()

    def excluded_places(self):
        """The handles of the committed excluded places (test_street_level... pins the Gramps IDs by place type)."""
        places = rs.by_gramps_id("Place")
        return {places[gid]["handle"] for gid in self.doc["excluded_places"]}

    def test_the_golden_is_the_legacy_output_for_a_real_tree(self):
        keys = set(self.legacy)
        self.assertGreater(len(keys), 100)
        for prefix in ("person", "family", "event", "note", "place", "media"):
            self.assertTrue(any(k.startswith(prefix + "/") for k in keys), prefix)
        for key in ("person/index.json", "person/search-index.json", "place/index.json", "media/index.json"):
            self.assertIn(key, keys)
        self.assertTrue(all(k.endswith(".json") for k in keys))

    def test_every_difference_is_listed_and_every_other_file_is_byte_identical(self):
        result = deltas.compare(self.legacy, self.render, self.excluded_places())
        self.assertEqual(result["unexplained"], [])
        self.assertEqual(result["only_in_render"], [])
        listed = {e["key"] for e in result["only_in_legacy"]} | {e["key"] for e in result["changed"]}
        identical = [k for k in self.legacy if k in self.render and k not in listed]
        self.assertGreater(len(identical), 80)
        for key in identical:
            self.assertEqual(self.legacy[key], self.render[key], key)

    def test_the_committed_delta_list_is_exactly_the_computed_one(self):
        result = deltas.compare(self.legacy, self.render, self.excluded_places())
        self.assertEqual(self.doc["only_in_legacy"], result["only_in_legacy"])
        self.assertEqual(self.doc["changed"], result["changed"])
        self.assertEqual(self.doc["only_in_render"], [])
        self.assertEqual(self.doc["rules"], deltas.RULES)
        self.assertEqual(self.doc["normalised"], deltas.NORMALISED)
        self.assertEqual(self.doc["manifest_order"], deltas.MANIFEST_ORDER)
        self.assertEqual(self.doc["fixture_basis"], deltas.FIXTURE_BASIS)
        self.assertEqual(self.doc["renderer_only"], deltas.RENDERER_ONLY)

    def test_every_listed_rule_exists_and_covers_something(self):
        used = {e["rule"] for e in self.doc["only_in_legacy"] + self.doc["changed"]}
        self.assertEqual(used, set(self.doc["rules"]))

    def test_street_level_and_home_like_places_are_the_listed_delta(self):
        by_id = rs.by_gramps_id("Place")
        excluded = set(self.doc["excluded_places"])
        # Farm 18, custom Home, Street 7, Building 19, Number 20 in the tree; Street 7 and a custom Summer Home in the supplement.
        self.assertEqual(excluded, {"P0003", "P0004", "P0006", "P0007", "P0010", "P9003", "P9004"})
        for gid in excluded:
            self.assertNotIn("place/%s.json" % by_id[gid]["handle"], self.render)
            self.assertIn("place/%s.json" % by_id[gid]["handle"], self.legacy)
        for gid in ("P0001", "P0002", "P0005", "P9001", "P9002", "P9005"):  # kept, including the custom 'Landmark'
            self.assertIn("place/%s.json" % by_id[gid]["handle"], self.render)
        # a re-pointed event lands on the nearest kept ancestor (the street's parent, the city)
        farm_event = next(e for e in self.doc["changed"] if e["key"].startswith("event/") and
                          e["changes"][0]["legacy"] == "Sample Farm")
        self.assertEqual([c["render"] for c in farm_event["changes"]],
                         ["Exampleville", "P0002", by_id["P0002"]["handle"]])

    def test_private_held_and_orphan_cases_need_no_delta(self):
        cases = deltas.no_delta_cases(rs.raw_tree(), rs.p_fixture(), parity_held(), self.legacy, self.render)
        self.assertEqual(self.doc["no_delta_cases"], cases)
        self.assertEqual(cases["orphan_of_private"], ["E0019", "E0037"])
        self.assertEqual(cases["withheld_by_text_gate"], ["N0010"])
        for gid in ("I0010", "I0011", "E0017", "F0006", "N0007", "O0005", "P0008", "S0002", "R0002"):
            self.assertTrue(any(gid in v for v in cases.values()), gid)

    def test_a_held_blob_renders_as_missing_on_both_sides(self):
        media = rs.by_gramps_id("Media")["O0002"]  # the photo with EXIF GPS: metadata renders, the blob is held
        key = "media/%s.json" % media["handle"]
        for tree in (self.legacy, self.render):
            doc = json.loads(tree[key])
            self.assertTrue(doc["missing"])
            self.assertIsNone(doc["checksum"])
            self.assertIsNone(doc["size"])

    def test_events_are_ordered_by_the_legacy_key(self):
        events = {o["handle"]: o for o in rs.p_fixture() if o["_class"] == "Event"}
        checked = 0
        for obj in rs.p_fixture():
            if obj["_class"] != "Person" or "person/%s.json" % obj["gramps_id"] not in self.render:
                continue
            doc = json.loads(self.render["person/%s.json" % obj["gramps_id"]])
            handles = [e["handle"] for e in doc["events"]]
            keys = [((events[h].get("date") or {}).get("sortval") or 0, e["label"]) for h, e in zip(handles, doc["events"])]
            self.assertEqual(keys, sorted(keys), obj["gramps_id"])
            checked += len(keys)
        self.assertGreater(checked, 30)
        self.assertIn("legacy key", self.doc["event_order"])

    def test_the_legacy_source_record_names_the_files_the_golden_came_from(self):
        with open(os.path.join(rs.RENDER_FIX, "golden", "legacy-source.json"), encoding="utf-8") as fh:
            source = json.load(fh)
        self.assertIn("scripts/etl/transform.py", source["files"])
        self.assertIn("scripts/search/build_search_index.js", source["files"])
        for digest in source["files"].values():
            self.assertRegex(digest, r"^[0-9a-f]{64}$")


def parity_held():
    return rs.parity.held_handles(rs.raw_tree())


if __name__ == "__main__":
    unittest.main()
