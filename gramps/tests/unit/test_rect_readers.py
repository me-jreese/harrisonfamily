"""Tag rectangles are read Gramps-exact (HFY-TSK-401, issue HFY-ISS-028, ruling P4-R16; spec DOC-E61934196E75 section 2).

One predicate, three call sites: ``hfygramps.rect`` (the helper), ``rules.rect_problem`` (the redaction rules), ``projection`` (the
lift, ``project_rect`` and the ``_rects`` pass) and ``render.transform`` (``mediaref_rect`` and ``collect_media_tags``). A region is
null only for the full frame and for a point; a box with one zero-extent axis is kept as typed; reversed corners are kept as stored,
because the spec's read side says "never rewrite a rect Gramps stored" (the fixtures' reversed rows describe a web WRITE, which the
JS ``normalizeRect`` orders; the Python readers do not repair). Reads the shared fixtures file, so Python, the JS API and the kit
agree. Standard library only.
"""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "gramps"))
sys.path.insert(0, HERE)

import render_support  # noqa: E402,F401  (puts the unit-test helpers on the path like the other tests)
import make_vectors as MV  # noqa: E402
import test_projection as TP  # noqa: E402
from hfygramps import projection as P  # noqa: E402
from hfygramps import rect as RECT  # noqa: E402
from hfygramps import rules as R  # noqa: E402
from hfygramps.render import transform  # noqa: E402
from hfygramps.render.transform import collect_media_tags, mediaref_rect  # noqa: E402

with open(os.path.join(ROOT, "tests", "tagging", "fixtures", "tag-conformance.fixtures.json"), encoding="utf-8") as fh:
    FX = json.load(fh)


def int_in_range(value):
    return (isinstance(value, list) and len(value) == 4 and all(isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 100 for v in value))


ROWS = [r for r in FX["normalizeRect"]["rows"] if int_in_range(r["in"])]
FULL = [r for r in ROWS if r["in"] == [0, 0, 100, 100]]
POINTS = [r for r in ROWS if r["in"][0] == r["in"][2] and r["in"][1] == r["in"][3]]
LINES = [r for r in ROWS if r["out"] is not None and r["in"] == r["out"] and (r["in"][0] == r["in"][2] or r["in"][1] == r["in"][3])]
REVERSED = [r for r in ROWS if r["id"].startswith("reversed-")]
KEPT = [r for r in ROWS if r["out"] is not None and r["in"] == r["out"]]


def expected_read(row):
    """What a reader returns for a stored integer rect: null for the full frame and a point, else the rect exactly as stored."""
    return None if row in FULL or row in POINTS else list(row["in"])


class Fixtures(unittest.TestCase):
    def test_the_selection_covers_every_kind(self):
        self.assertGreaterEqual(len(FULL), 1)
        self.assertGreaterEqual(len(POINTS), 3)
        self.assertGreaterEqual(len(LINES), 2)
        self.assertGreaterEqual(len(REVERSED), 2)
        self.assertGreaterEqual(len(KEPT), 8)

    def test_every_reader_agrees_with_the_fixtures_on_every_integer_row(self):
        for row in ROWS:
            want = expected_read(row)
            if row in FULL or row in POINTS:
                self.assertIsNone(row["out"], row["id"])  # the fixtures agree: no region
            elif row["in"] == row["out"]:
                self.assertEqual(want, row["out"], row["id"])  # kept as typed
            self.assertEqual(RECT.normalize_rect(row["in"]), want, row["id"])
            self.assertEqual(mediaref_rect(row["in"]), want, row["id"])
            problem = R.rect_problem(row["in"])
            self.assertEqual(problem, "full_frame" if row in FULL else "no_region" if row in POINTS else None, row["id"])
            cloud, held = P.project_rect(row["in"], [9, 9, 19, 19])
            self.assertFalse(held, row["id"])
            self.assertEqual(cloud, want, row["id"])


class Helper(unittest.TestCase):
    def test_null_and_empty_and_malformed_are_no_region(self):
        for raw in (None, [], (), [1, 2, 3], [1, 2, 3, 4, 5], "x", [1.5, 2, 3, 4], [True, 0, 5, 5], ["1", 2, 3, 4]):
            self.assertIsNone(RECT.normalize_rect(raw), raw)

    def test_full_frame_all_zero_and_points_are_no_region(self):
        for raw in ([0, 0, 100, 100], [0, 0, 0, 0], [40, 40, 40, 40], (5, 5, 5, 5), [100, 100, 100, 100]):
            self.assertIsNone(RECT.normalize_rect(raw), raw)

    def test_a_box_with_one_zero_extent_axis_is_kept_as_typed(self):
        self.assertEqual(RECT.normalize_rect([10, 10, 10, 50]), [10, 10, 10, 50])
        self.assertEqual(RECT.normalize_rect([10, 30, 60, 30]), [10, 30, 60, 30])

    def test_reversed_corners_are_kept_as_stored(self):
        self.assertEqual(RECT.normalize_rect([58, 93, 12, 7]), [58, 93, 12, 7])
        self.assertEqual(RECT.normalize_rect([58, 7, 12, 93]), [58, 7, 12, 93])
        self.assertEqual(RECT.normalize_rect([100, 100, 0, 0]), [100, 100, 0, 0])  # a reversed full frame is neither the literal full frame nor a point

    def test_the_result_is_a_copy(self):
        src = [1, 2, 30, 40]
        out = RECT.normalize_rect(src)
        out[0] = 99
        self.assertEqual(src, [1, 2, 30, 40])


class RulesCallSite(unittest.TestCase):
    def test_full_frame_and_point_are_no_region_not_a_hold(self):
        self.assertEqual(R.rect_problem([0, 0, 100, 100]), "full_frame")
        self.assertEqual(R.rect_problem([0.0, 0.0, 100.0, 100.0]), "full_frame")
        self.assertEqual(R.rect_problem([40, 40, 40, 40]), "no_region")
        self.assertEqual(R.rect_problem([0, 0, 0, 0]), "no_region")

    def test_lines_and_reversed_corners_are_not_held(self):
        for rect in ([10, 10, 10, 50], [10, 30, 60, 30], [58, 93, 12, 7], [60, 10, 50, 70], [10, 70, 50, 60], [100, 10, 100, 50]):
            self.assertIsNone(R.rect_problem(rect), rect)

    def test_fraction_range_and_shape_are_still_held(self):
        for bad in ([12.5, 10, 50, 60], [10, 10, 101, 60], [-1, 0, 5, 5], [10, 10, 50], "x", [True, 0, 5, 5], [0, 0, 100, 100.5]):
            self.assertEqual(R.rect_problem(bad), "degenerate_or_float", bad)


class ProjectionCallSite(unittest.TestCase):
    def test_project_rect(self):
        base = [3, 3, 30, 30]
        self.assertEqual(P.project_rect([0, 0, 100, 100], base), (None, False))
        self.assertEqual(P.project_rect([40, 40, 40, 40], base), (None, False))
        self.assertEqual(P.project_rect([10, 10, 10, 50], base), ([10, 10, 10, 50], False))
        self.assertEqual(P.project_rect([58, 93, 12, 7], base), ([58, 93, 12, 7], False))
        self.assertEqual(P.project_rect([12.5, 10, 50, 60], base), (base, True))

    def test_the_lift_pass_nulls_the_full_frame_and_a_point_and_keeps_the_rest(self):
        photo = MV.MED("m1")
        refs = [MV.MR("m1", r) for r in ([0, 0, 100, 100], [40, 40, 40, 40], [10, 10, 10, 50], [58, 93, 12, 7], [10, 10, 50, 60], [12.5, 10, 50, 60])]
        base = MV.PE("p1", media_list=[MV.MR("m1", [3, 3, 30, 30]) for _ in refs])
        res = TP.run([photo, MV.PE("p1", media_list=refs)], base={"p1": base})
        self.assertEqual([m["rect"] for m in res.projected["p1"]["media_list"]],
                         [None, None, [10, 10, 10, 50], [58, 93, 12, 7], [10, 10, 50, 60], [3, 3, 30, 30]])
        self.assertEqual([(h["pointer"], h["rule"]) for h in res.holds], [("/media_list/5/rect", "media.rect.degenerate_or_float")])


class FakeRepo:
    def __init__(self, person, media):
        self.person, self.media = person, media

    def iter_person_handles(self):
        return [("pe1", "I0001")]

    def fetch(self, table, handle):
        return {"person": {"pe1": self.person}, "media": self.media, "note": {}, "citation": {}}.get(table, {}).get(handle)


class TransformCallSite(unittest.TestCase):
    def tags_for(self, rects):
        person = {
            "handle": "pe1", "gramps_id": "I0001", "private": False,
            "primary_name": {"first_name": "Ann", "surname_list": [{"surname": "Fixture", "primary": True, "origintype": {"value": 1}}], "private": False},
            "media_list": [{"ref": "m1", "rect": r, "private": False, "note_list": [], "attribute_list": [], "citation_list": []} for r in rects],
        }
        media = {"m1": {"handle": "m1", "gramps_id": "O0001", "private": False}}
        found = collect_media_tags(FakeRepo(person, media), transform.default_text_gate)
        return found

    def test_a_full_frame_a_point_and_all_zero_render_as_no_region(self):
        found = self.tags_for([[0, 0, 100, 100], [40, 40, 40, 40], [0, 0, 0, 0], None])
        recs = found.by_media["m1"]
        self.assertEqual([r["rect"] for r in sorted(recs, key=lambda r: r["refIndex"])], [None, None, None, None])
        self.assertEqual(found.counts["tags"], 4)
        self.assertEqual(found.counts["tags_with_rect"], 0)
        self.assertEqual(found.counts["rect_malformed"], 0)

    def test_a_one_axis_zero_box_and_reversed_corners_render_as_typed(self):
        found = self.tags_for([[10, 10, 10, 50], [10, 30, 60, 30], [58, 93, 12, 7], [12, 7, 58, 93]])
        recs = sorted(found.by_media["m1"], key=lambda r: r["refIndex"])
        self.assertEqual([r["rect"] for r in recs], [[10, 10, 10, 50], [10, 30, 60, 30], [58, 93, 12, 7], [12, 7, 58, 93]])
        self.assertEqual(found.counts["tags_with_rect"], 4)

    def test_malformed_is_still_counted_and_reads_as_no_region(self):
        found = self.tags_for([[1, 2, 3], [1.5, 2, 3, 4]])
        self.assertEqual([r["rect"] for r in sorted(found.by_media["m1"], key=lambda r: r["refIndex"])], [None, None])
        self.assertEqual(found.counts["rect_malformed"], 2)


if __name__ == "__main__":
    unittest.main()
