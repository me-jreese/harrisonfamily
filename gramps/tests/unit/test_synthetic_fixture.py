"""Stdlib-only check of the committed synthetic fixture tree and its Gramps-generated goldens.

Nothing here imports Gramps, so any worker or CI job can run it:

    python3 -m unittest discover gramps/tests/unit

It verifies the committed files against their sha256 manifest, runs the census (every case
sync.md section 15 and the review scenarios need), cross-checks the XML against the JSONL, scans
every string for anything that is not obviously fictional, and checks the D-03 allowlist lines.
One test regenerates the files with the bundled Gramps and compares bytes; it skips when the
bundle is absent.
"""
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import unittest
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
FIX = os.path.join(REPO, "gramps", "tests", "fixtures")
sys.path.insert(0, FIX)
import census  # noqa: E402

JSONL = os.path.join(FIX, "synthetic-tree.jsonl")
GRAMPS_XML = os.path.join(FIX, "synthetic-tree.gramps")
ALLOWLIST = os.path.join(REPO, "scripts", "ci", "data-sample-allowlist.txt")
XML_TAG = {"Person": "person", "Family": "family", "Event": "event", "Place": "placeobj", "Source": "source",
           "Citation": "citation", "Repository": "repository", "Media": "object", "Note": "note", "Tag": "tag"}
NS = "{http://gramps-project.org/xml/1.7.2/}"


def objects():
    return census.load_jsonl(JSONL)


class Census(unittest.TestCase):
    def test_every_required_case_is_present(self):
        result = census.run_census(objects())
        self.assertEqual(census.missing(result), [])

    def test_committed_census_file_matches_a_fresh_census(self):
        with open(os.path.join(FIX, "synthetic-tree.census.json"), encoding="utf-8") as fh:
            committed = json.load(fh)
        self.assertEqual(committed, census.run_census(objects()))

    def test_census_catches_a_dropped_case(self):
        objs = [o for o in objects() if not (o["_class"] == "Place" and o["place_type"]["value"] == census.PLACE_FARM)]
        self.assertIn("farm_place", census.missing(census.run_census(objs)))

    def test_review_scenarios_by_name(self):
        r = census.run_census(objects())
        for case in ("birth_retype_target", "stillbirth_event", "baptism_deceased_with_day", "range_birth_date",
                     "textonly_birth_date", "birth_citation_full_date", "birth_name_with_date",
                     "media_birth_certificate_pdf", "private_person_exclusive_event_note_photo", "private_family",
                     "private_child_ref", "farm_place", "custom_home_place", "place_six_decimal_coordinates",
                     "two_tags_of_one_person_in_one_photo", "rect_full_frame_0_0_100_100", "rect_float"):
            self.assertTrue(r[case], case)


class GoldenFiles(unittest.TestCase):
    def test_sha256_manifest_matches(self):
        self.assertEqual(census.verify_files(FIX), [])

    def test_jsonl_is_one_sorted_object_per_line(self):
        with open(JSONL, encoding="utf-8") as fh:
            lines = fh.read().split("\n")
        self.assertEqual(lines[-1], "")
        for line in lines[:-1]:
            o = json.loads(line)
            self.assertIn("_class", o)
            self.assertEqual(line, json.dumps(o, sort_keys=True, ensure_ascii=False, separators=(",", ":")))

    def test_xml_is_plain_and_matches_jsonl(self):
        with open(GRAMPS_XML, "rb") as fh:
            head = fh.read(5)
        self.assertEqual(head, b"<?xml", "the .gramps golden is plain XML, not gzip")
        root = ET.parse(GRAMPS_XML).getroot()
        by_class = {}
        for o in objects():
            by_class.setdefault(o["_class"], []).append(o)
        for cls, tag in XML_TAG.items():
            # only the top-level container children count, not nested elements of the same name
            container = {"person": "people", "family": "families", "event": "events", "placeobj": "places",
                         "source": "sources", "citation": "citations", "repository": "repositories",
                         "object": "objects", "note": "notes", "tag": "tags"}[tag]
            top = root.find(NS + container)
            xml_handles = sorted(e.get("handle") for e in top.findall(NS + tag))
            json_handles = sorted("_" + o["handle"] for o in by_class.get(cls, []))
            self.assertEqual(xml_handles, json_handles, cls)

    def test_ids_are_the_fixture_ones_and_handles_unique(self):
        objs = objects()
        handles = [o["handle"] for o in objs]
        self.assertEqual(len(handles), len(set(handles)))
        ids = [(o["_class"], o["gramps_id"]) for o in objs if "gramps_id" in o]
        self.assertEqual(len(ids), len(set(ids)))

    def test_change_times_are_fixed(self):
        self.assertEqual({o["change"] for o in objects()}, {1700000000})


FICTIONAL_OK = re.compile(
    r"^(?:555-01\d\d|15555550\d\d\d|\+15555550\d\d\d)$")


class AllFictional(unittest.TestCase):
    def strings(self):
        out = []

        def walk(n):
            if isinstance(n, str):
                out.append(n)
            elif isinstance(n, dict):
                for v in n.values():
                    walk(v)
            elif isinstance(n, list):
                for v in n:
                    walk(v)

        for o in objects():
            walk(o)
        return out

    def test_every_email_is_example_org(self):
        for s in self.strings():
            for m in re.finditer(r"[\w.+-]+@([\w.-]+)", s):
                self.assertTrue(m.group(1).endswith("example.org"), m.group(0))

    def test_every_hostname_is_documentation_or_the_contact_channel(self):
        for s in self.strings():
            for m in re.finditer(r"https?://([^/\s]+)", s):
                host = m.group(1)
                self.assertTrue(host == "example.org" or host.endswith(".example.org") or host == "wa.me", host)

    def test_every_phone_is_in_the_reserved_555_01xx_range(self):
        for s in self.strings():
            for m in re.finditer(r"\+?\d[\d\- ]{6,}\d", s):
                digits = m.group(0).strip()
                if re.fullmatch(r"\d{4}( \d{4})*", digits) or re.fullmatch(r"[0-9a-f]{28}", digits):
                    continue
                # dates, handles and md5 sums contain long digit runs; only phone-shaped strings are checked
                if re.fullmatch(r"\+?1?\d{3}-\d{4}", digits) or digits.startswith("+1") or digits.startswith("1555"):
                    self.assertRegex(digits.replace("-", ""), r"^\+?(1)?5550?1\d\d$|^\+?15555550\d\d\d$", digits)

    def test_no_phone_shaped_text_outside_the_reserved_range(self):
        pat = re.compile(r"(?<![\w.-])(?:\d{3}-\d{4})(?![\w-])")
        for s in self.strings():
            for m in pat.finditer(s):
                self.assertRegex(m.group(0), r"^555-01\d\d$", s)

    def test_ssn_style_value_is_the_unissued_all_zero_one(self):
        for s in self.strings():
            for m in re.finditer(r"\b\d{3}-\d{2}-\d{4}\b", s):
                self.assertEqual(m.group(0), "000-00-0000")


class MediaFiles(unittest.TestCase):
    def read(self, name):
        with open(os.path.join(FIX, "media", name), "rb") as fh:
            return fh.read()

    def test_media_checksums_in_the_tree_match_the_files(self):
        for o in objects():
            if o["_class"] == "Media":
                self.assertEqual(o["checksum"], hashlib.md5(self.read(os.path.basename(o["path"]))).hexdigest(), o["path"])

    def test_placeholder_is_zero_bytes(self):
        self.assertEqual(self.read("synthetic-placeholder.jpg"), b"")

    def test_pdf_header(self):
        self.assertTrue(self.read("synthetic-birth-certificate.pdf").startswith(b"%PDF-"))

    @staticmethod
    def exif_gps_tags(data):
        """Tag numbers in the GPS IFD of a JPEG's EXIF segment, or None when there is no GPS IFD."""
        if data[:2] != b"\xff\xd8":
            raise AssertionError("not a JPEG")
        pos = 2
        while pos + 4 <= len(data) and data[pos] == 0xFF:
            marker, length = data[pos + 1], struct.unpack(">H", data[pos + 2:pos + 4])[0]
            seg = data[pos + 4:pos + 2 + length]
            if marker == 0xE1 and seg[:6] == b"Exif\x00\x00":
                tiff = seg[6:]
                end = "<" if tiff[:2] == b"II" else ">"

                def ifd(off):
                    n = struct.unpack(end + "H", tiff[off:off + 2])[0]
                    return {struct.unpack(end + "H", tiff[off + 2 + 12 * i:off + 4 + 12 * i])[0]:
                            tiff[off + 2 + 12 * i:off + 14 + 12 * i] for i in range(n)}

                zero = ifd(struct.unpack(end + "I", tiff[4:8])[0])
                if 0x8825 not in zero:
                    return None
                gps_off = struct.unpack(end + "I", zero[0x8825][8:12])[0]
                return sorted(ifd(gps_off))
            pos += 2 + length
        return None

    def test_gps_jpeg_carries_gps_latitude_and_longitude(self):
        tags = self.exif_gps_tags(self.read("synthetic-photo-gps.jpg"))
        self.assertIsNotNone(tags)
        for t in (1, 2, 3, 4):  # GPSLatitudeRef, GPSLatitude, GPSLongitudeRef, GPSLongitude
            self.assertIn(t, tags)

    def test_plain_jpeg_has_no_gps(self):
        self.assertIsNone(self.exif_gps_tags(self.read("synthetic-photo-plain.jpg")))


class AllowlistGuard(unittest.TestCase):
    def test_gramps_and_jsonl_goldens_are_allowlisted_with_current_hashes(self):
        with open(ALLOWLIST, encoding="utf-8") as fh:
            entries = {line.split(None, 1)[1].strip(): line.split()[0]
                       for line in fh if line.strip() and not line.startswith("#")}
        for name in ("synthetic-tree.gramps", "synthetic-tree.jsonl"):
            path = "gramps/tests/fixtures/" + name
            self.assertIn(path, entries)
            self.assertEqual(entries[path], census.sha256_file(os.path.join(FIX, name)))


APP = os.environ.get("HFY_GRAMPS_APP", "/Applications/Gramps.app")


@unittest.skipUnless(sys.platform == "darwin" and os.path.isdir(APP) and not os.environ.get("HFY_SKIP_REGEN"),
                     "needs the Gramps 6.0.6 bundle on macOS")
class Reproducible(unittest.TestCase):
    def test_regeneration_is_byte_identical(self):
        shim = os.path.join(REPO, "gramps", "tests", "gramps", "gramps-shim.sh")
        home = subprocess.run(["mktemp", "-d"], capture_output=True, text=True, check=True).stdout.strip()
        try:
            env = dict(os.environ, HOME=home, GRAMPSHOME=home)
            r = subprocess.run([shim, "--script", os.path.join(FIX, "make_synthetic_tree.py"), "--check"],
                               capture_output=True, text=True, env=env, timeout=300)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        finally:
            shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
