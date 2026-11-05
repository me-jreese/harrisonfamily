"""The renderer's second text gate (hfygramps/render/text_scan.py, HFY-TSK-114) and its one timestamp exception (HFY-TSK-375).

Any day-precise date blocks, a bare YYYYMMDD included, because it could be a birth date. A calendar-valid YYYYMMDD directly
followed by exactly one of _ - T or a space and a valid six-digit HHMMSS is a camera timestamp, not a birth date, unless a birth
keyword is within the detector's window on either side. Every string is synthetic. Standard library only.

Run: python3 -m unittest discover gramps/tests/unit
"""

import pathlib
import sys
import time
import unittest

GRAMPS = pathlib.Path(__file__).resolve().parents[2]
if str(GRAMPS) not in sys.path:
    sys.path.insert(0, str(GRAMPS))

from hfygramps import scanner  # noqa: E402
from hfygramps.render import policy, text_scan  # noqa: E402

DAY = {"date_day": 1}
CPU_GUARD_SECONDS = 10.0


def lenient(text):
    return text_scan.blocking_hits(text)


class TimestampIsNotADate(unittest.TestCase):
    def test_camera_names_are_not_a_day_precise_date(self):
        for text in ("20130519_172413", "IMG_20130519_172413", "IMG_20130519_172413.jpg", "20130519T172413Z", "20130519 172413",
                     "20130519-172413", "taken 20130519_172413 by the lake", "Ann’s photo 20130519_172413",
                     "20240229_000000", "20000229_235959", "20130519_172413 and 20130520_081530"):
            self.assertEqual(lenient(text), {}, text)
            self.assertTrue(policy.default_text_gate(text), text)

    def test_a_14_digit_run_was_never_a_day_precise_date(self):
        # the pattern ends at a digit boundary, so a longer run never matched; unchanged by HFY-TSK-375
        self.assertEqual(lenient("20130519172413"), {})

    def test_strict_counts_every_day(self):
        for text in ("20130519_172413", "IMG_20130519_172413", "20130519 172413", "20130519T172413"):
            self.assertEqual(text_scan.blocking_hits(text, strict=True), DAY, text)
        self.assertEqual(text_scan.blocking_hits("20130519_172413 and 20130519", strict=True), {"date_day": 2})


class NearMissesStayDates(unittest.TestCase):
    def test_a_bare_date_or_a_short_or_long_time(self):
        for text in ("19450312", "photo 19450312.", "19450312_1430", "19450312 1430", "19450312-14", "19450312_14300", "19450312_1430001",
                     "19450312_143000123", "19450312__143000", "19450312  143000", "19450312/143000", "19450312.143000",
                     "19450312_143000_", "143000_19450312", "1430 19450312"):
            expected = {} if text == "19450312_143000_" else DAY
            self.assertEqual(lenient(text), expected, text)

    def test_the_time_must_be_a_time(self):
        for text in ("19450312_246000", "19450312_240000", "19450312_146000", "19450312_143060", "19450312_999999"):
            self.assertEqual(lenient(text), DAY, text)

    def test_the_date_must_exist(self):
        for text in ("19450230_143000", "20230229_143000", "19000229_143000", "19450431_143000"):
            self.assertEqual(lenient(text), DAY, text)
        # a month 13 or a day 00 or 32 never matched the pattern; the R-18 detector holds them as numbers
        for text in ("19451332_143000", "19450300_143000", "19450332_143000"):
            self.assertEqual(lenient(text), {}, text)
            self.assertFalse(policy.default_text_gate(text), text)

    def test_a_year_outside_the_pattern_is_not_a_date_here(self):
        self.assertEqual(lenient("21000101_143000"), {})  # not year-like; the R-18 detector holds it as a number
        self.assertFalse(policy.default_text_gate("21000101_143000"))

    def test_a_separated_date_is_still_a_date(self):
        for text in ("1945-03-12 14:30:00", "1945-03-12_143000", "12/03/1945 143000", "1945.03.12T14:30"):
            self.assertEqual(lenient(text), DAY, text)

    def test_a_stamp_beside_a_bare_date_counts_only_the_bare_date(self):
        self.assertEqual(lenient("19450312_143000 and 19450312"), DAY)
        self.assertEqual(lenient("19450312 and 19450312_143000"), DAY)


class BirthWordsKeepTheDate(unittest.TestCase):
    def test_a_birth_word_on_either_side(self):
        for text in ("born 19450312_143000", "born 19450312 143000", "born: 19450312_143000", "DOB: 19450312_143000",
                     "dob 19450312-143000", "b. 19450312_143000", "birthday 19450312T143000", "19450312_143000 born",
                     "19450312_143000 is her birthday", "date of birth 19450312 143000", "baptized 19450312_143000",
                     "Born in the old house, photo IMG_19450312_143000", "birth 19450312_143000"):
            self.assertEqual(lenient(text), DAY, text)
            self.assertFalse(policy.default_text_gate(text), text)

    def test_the_window_is_the_detectors_window(self):
        far = "x" * (scanner.DOB_WINDOW + 20)
        self.assertEqual(lenient("born " + far + " 19450312_143000"), {})
        self.assertEqual(lenient("19450312_143000 " + far + " born"), {})
        near = "x" * (scanner.DOB_WINDOW - 8)
        self.assertEqual(lenient("born " + near + " 19450312_143000"), DAY)
        self.assertEqual(lenient("19450312_143000 " + near + " born"), DAY)

    def test_an_invisible_character_does_not_hide_the_word(self):
        for text in ("bo​rn 19450312_143000", "b­orn 19450312_143000", "’born’ 19450312_143000",
                     "Ann’s birthday, 19450312_143000"):
            self.assertEqual(lenient(text), DAY, text)

    def test_a_word_that_only_contains_a_birth_word_is_not_one(self):
        # birthplace and unborn are different words; the R-18 detector reads whole words only
        self.assertEqual(lenient("birthplace photo 20130519_172413"), {})

    def test_an_event_word_that_is_not_a_birth_word_does_not_keep_it(self):
        for text in ("died 19450312_143000", "married 19450312_143000", "buried 19450312_143000"):
            self.assertEqual(lenient(text), {}, text)
            self.assertTrue(policy.default_text_gate(text), text)


class Linear(unittest.TestCase):
    def test_100k_characters_of_stamps_and_birth_words(self):
        n = 100000

        def fill(s):
            return (s * (n // len(s) + 1))[:n]

        for s in (fill("20130519_172413 "), fill("born 20130519_172413 "), fill("20130519_172413 born "), fill("’" + "x" * 30 + "20130519 172413 "),
                  fill("b​o 20130519_172413 ")):
            t0 = time.process_time()
            text_scan.scan_text(s)
            self.assertLess(time.process_time() - t0, CPU_GUARD_SECONDS, ascii(s[:16]))


if __name__ == "__main__":
    unittest.main()
