"""Tagging conformance, Python half (HFY-TSK-387-0A, plan HFY-PLN-004): BRD rows T-3, T-4 and T-12 against hfygramps.

Reads the same fixtures file as the node suite (tests/tagging/fixtures/tag-conformance.fixtures.json, rect rules under architect
ruling P4-R16: Gramps-exact for read/compare, null only for the full frame and a point; a box with one zero-extent axis is kept).
Standard library only. Runs in the io-kit CI `tests` list through `python3 -m unittest discover gramps/tests/unit`.

Since HFY-TSK-401 (HFY-ISS-028) the renderer, the rules and the projection read rectangles Gramps-exact through hfygramps/rect.py, so
there are no known-fail rows left here; the baseline is docs/reference/BASELINE.md. The per-call-site tests are in test_rect_readers.py.
"""

import json
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "gramps"))

import render_support  # noqa: E402,F401  (puts the unit-test helpers on the path like the other tests)
from hfygramps import projection, rules  # noqa: E402
from hfygramps.render import transform  # noqa: E402

with open(os.path.join(ROOT, "tests", "tagging", "fixtures", "tag-conformance.fixtures.json"), encoding="utf-8") as fh:
    FX = json.load(fh)

ROWS = {r["id"]: r for r in FX["normalizeRect"]["rows"]}


def is_int_rect(value):
    return isinstance(value, list) and len(value) == 4 and all(isinstance(v, int) and not isinstance(v, bool) for v in value)


def in_range_ints(r):
    v = r["in"]
    return is_int_rect(v) and all(0 <= x <= 100 for x in v)


POINTS = [r for r in FX["normalizeRect"]["rows"] if in_range_ints(r) and r["in"][0] == r["in"][2] and r["in"][1] == r["in"][3] and r["in"] != [0, 0, 0, 0]]
LINES = [r for r in FX["normalizeRect"]["rows"] if in_range_ints(r) and r["out"] is not None and r["in"] == r["out"] and (r["in"][0] == r["in"][2] or r["in"][1] == r["in"][3])]


class T3FullFrame(unittest.TestCase):
    def test_fixture_selection_is_not_empty(self):
        self.assertGreaterEqual(len(POINTS), 2)
        self.assertGreaterEqual(len(LINES), 2)

    def test_rules_classify_the_full_frame(self):
        """T-3: rules.rect_problem names the full frame, which the projection turns into null."""
        self.assertEqual(rules.rect_problem([0, 0, 100, 100]), "full_frame")

    def test_rules_keep_an_ordinary_region(self):
        self.assertIsNone(rules.rect_problem([30, 47, 34, 54]))

    def test_render_reader_nulls_the_full_frame(self):
        """T-3: transform.mediaref_rect reads the full frame as no region, as Gramps does."""
        self.assertIsNone(transform.mediaref_rect([0, 0, 100, 100]))

    def test_render_reader_nulls_all_zero(self):
        self.assertIsNone(transform.mediaref_rect([0, 0, 0, 0]))


class T4Degenerate(unittest.TestCase):
    def test_import_of_every_fixture_rect_does_not_crash(self):
        for r in FX["normalizeRect"]["rows"]:
            v = r["in"]
            if is_int_rect(v) or (isinstance(v, list) and len(v) == 4 and all(isinstance(x, (int, float)) for x in v)):
                rules.rect_problem(v)
                transform.mediaref_rect(v)

    def test_render_reader_keeps_a_line_as_typed(self):
        for r in LINES:
            self.assertEqual(transform.mediaref_rect(r["in"]), r["out"], r["id"])

    def test_render_reader_nulls_a_point(self):
        """T-4: transform.mediaref_rect reads a point as no region."""
        for r in POINTS:
            self.assertIsNone(transform.mediaref_rect(r["in"]), r["id"])

    def test_rules_do_not_hold_a_line(self):
        """T-4: rules.rect_problem keeps a line (one zero-extent axis) as typed."""
        for r in LINES:
            self.assertIsNone(rules.rect_problem(r["in"]), r["id"])

    def test_rules_do_not_hold_a_point(self):
        """T-4: a point is no region (P4-R16), not a held rectangle."""
        for r in POINTS:
            self.assertNotEqual(rules.rect_problem(r["in"]), "degenerate_or_float", r["id"])


class T4ProjectionRestoresBase(unittest.TestCase):
    PROJECTION = os.path.join(ROOT, "gramps", "hfygramps", "projection.py")

    def test_projection_still_routes_by_rect_problem(self):
        """The projection nulls full_frame and no_region (a point) and restores the base rect for degenerate_or_float."""
        with open(self.PROJECTION, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn('problem in ("full_frame", "no_region")', text)
        self.assertIn('problem == "degenerate_or_float"', text)

    def test_projection_does_not_restore_base_for_a_line_or_point(self):
        """T-4: the projection nulls a point and keeps a line; neither is held (the base rect is not restored)."""
        for r in LINES + POINTS:
            self.assertNotEqual(rules.rect_problem(r["in"]), "degenerate_or_float", r["id"])
            self.assertEqual(projection.project_rect(r["in"], [9, 9, 19, 19]), (r["out"], False), r["id"])


class T12OriginBlind(unittest.TestCase):
    """T-12: living and moderated persons' tags are hidden identically for web and desk origin. A MediaRef carries no origin, so
    this is structural: nothing on the render, rules or redaction path reads one. The behavioural twin test needs the hfy-web-upload
    Tag (D-34), which is not shipped."""

    FILES = [
        os.path.join("gramps", "hfygramps", "render", "transform.py"),
        os.path.join("gramps", "hfygramps", "rules.py"),
        os.path.join("gramps", "hfygramps", "projection.py"),
        os.path.join("gramps", "redaction", "redaction-v1.json"),
    ]
    ORIGIN = re.compile(r"hfy-web-upload|hfy-post|from_web|web_tag|uploaded_by|created_via", re.I)

    def test_no_origin_input_on_the_redaction_path(self):
        for rel in self.FILES:
            with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
                self.assertIsNone(self.ORIGIN.search(fh.read()), rel)

    def test_the_tag_source_is_one_constant(self):
        self.assertEqual(transform.TAG_SOURCE, "gramps")


if __name__ == "__main__":
    unittest.main()
