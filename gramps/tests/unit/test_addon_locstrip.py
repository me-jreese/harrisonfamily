"""The location strip (HFY-TSK-374): a lossless copy of a JPEG or PNG without its GPS position, or no copy at all.

    cd gramps/tests/unit && python3 -m unittest test_addon_locstrip

Every image here is built from fabricated bytes and a fabricated position (locstrip_support.py); no real photo is read. The strip works
on bytes, so these tests never touch a file. Pillow, when it is installed, decodes the copies as a second opinion; nothing needs it.
Standard library only otherwise; Python 3.9 compatible.
"""
import hashlib
import os
import random
import struct
import sys
import unittest
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))

import locstrip_support as LS  # noqa: E402
from hfygramps.addon import locstrip, mediafile  # noqa: E402

try:
    from PIL import Image
except ImportError:  # pragma: no cover - optional second opinion
    Image = None

JPEG, PNG = "image/jpeg", "image/png"


def thumbnail(order="<"):
    """A tiny JPEG that carries an Exif APP1 with a GPS IFD of its own: the thumbnail inside IFD1."""
    return LS.jpeg(LS.build_tiff(order, gps=True))


class Checks(unittest.TestCase):
    """The assertions every successful strip must pass."""

    def assertClean(self, out, ct):
        self.assertFalse(mediafile.exif_gps(out, ct), "the add-on's own detector finds no position")
        self.assertFalse(locstrip.has_location_residue(out, ct), "the independent scan finds no position")
        for token in LS.coordinate_bytes():
            self.assertNotIn(token, out, "no coordinate bytes are left in the file")
        self.assertNotIn(b"gps", out.lower().replace(b"\x00", b"")[:4096] if ct == JPEG else b"", "no GPS word in the metadata")

    def strip_ok(self, data, ct):
        before = hashlib.sha256(data).hexdigest()
        out, reason = locstrip.strip(data, ct)
        self.assertEqual(hashlib.sha256(data).hexdigest(), before, "the input is never changed")
        self.assertIsNotNone(out, reason)
        self.assertEqual(reason, "")
        return out


class Jpeg(Checks):
    def test_exif_gps_is_removed_and_everything_else_is_the_original(self):
        for order in "<>":
            tiff = LS.build_tiff(order)
            data = LS.jpeg(tiff)
            self.assertTrue(mediafile.exif_gps(data, JPEG))
            out = self.strip_ok(data, JPEG)
            self.assertClean(out, JPEG)
            self.assertEqual(len(out), len(data), "the copy is exactly as long: no length or offset had to change")
            at = LS.scan_start(data)
            self.assertEqual(out[at:], data[at:], "the compressed picture data and the end of the file are byte for byte the original's")
            head = data.index(b"Exif\x00\x00")
            self.assertEqual(out[:head], data[:head], "every segment before the Exif is untouched")
            self.assertEqual(out[at - 80:at], data[at - 80:at], "and so are the segments after it")

    def test_every_other_exif_tag_keeps_its_value(self):
        for order in "<>":
            data = LS.jpeg(LS.build_tiff(order))
            out = self.strip_ok(data, JPEG)
            start = out.index(b"Exif\x00\x00") + 6
            tags = LS.read_tags(out[start:start + len(LS.build_tiff(order))])
            self.assertIsNone(tags["gps"], "no GPS IFD")
            self.assertNotIn(0x8825, tags["ifd0"], "and no pointer to one")
            before = LS.read_tags(LS.build_tiff(order))
            self.assertEqual({t: v for t, v in before["ifd0"].items() if t != 0x8825}, tags["ifd0"])
            self.assertEqual(before["exif"], tags["exif"])
            self.assertEqual(tags["ifd0"][0x010F][2], LS.MAKE + b"\x00")
            self.assertEqual(tags["ifd0"][0x0112][2][:2], struct.pack(order + "H", 6), "the orientation")
            self.assertEqual(tags["exif"][0x927C][2], LS.MAKER_NOTE, "the maker note is not touched")

    def test_xmp_gps_is_blanked_in_both_spellings_and_the_rest_of_the_packet_stays(self):
        for style in ("attribute", "element"):
            xmp = LS.xmp_packet(style=style)
            data = LS.jpeg(xmp=xmp)
            self.assertTrue(mediafile.exif_gps(data, JPEG) or b"GPSLatitude" in data)
            out = self.strip_ok(data, JPEG)
            self.assertClean(out, JPEG)
            self.assertEqual(len(out), len(data))
            text = out[out.index(b"<?xpacket begin"):out.index(b"<?xpacket end")].decode("latin-1")
            root = ET.fromstring(text[text.index("<x:xmpmeta"):])         # still well-formed XML
            self.assertIn("Synthetic title", ET.tostring(root, encoding="unicode"))
            self.assertIn('exif:DateTimeOriginal="2001-02-03T04:05:06"', text)
            at = LS.scan_start(data)
            self.assertEqual(out[at:], data[at:])

    def test_exif_and_xmp_together(self):
        data = LS.jpeg(LS.build_tiff(), LS.xmp_packet())
        out = self.strip_ok(data, JPEG)
        self.assertClean(out, JPEG)
        at = LS.scan_start(data)
        self.assertEqual((len(out), out[at:]), (len(data), data[at:]))

    def test_a_thumbnail_inside_the_exif_is_cleaned_too(self):
        thumb = thumbnail()
        self.assertTrue(mediafile.exif_gps(LS.jpeg(LS.build_tiff(gps=False, thumb=thumb)), JPEG), "the detector sees the thumbnail's Exif")
        data = LS.jpeg(LS.build_tiff(gps=False, thumb=thumb))
        out = self.strip_ok(data, JPEG)
        self.assertClean(out, JPEG)
        self.assertEqual(len(out), len(data))
        both = LS.jpeg(LS.build_tiff(gps=True, thumb=thumb))
        out2 = self.strip_ok(both, JPEG)
        self.assertClean(out2, JPEG)
        self.assertEqual(out2[out2.index(b"\xff\xd8", 3):out2.index(b"\xff\xd8", 3) + 2], b"\xff\xd8", "the thumbnail is still a JPEG")

    def test_a_gps_pointer_in_ifd1_is_removed(self):
        data = LS.jpeg(LS.build_tiff(gps=False, thumb=LS.jpeg(), gps_in_ifd1=True))
        out = self.strip_ok(data, JPEG)
        self.assertClean(out, JPEG)

    def test_a_clean_file_comes_back_as_it_was(self):
        data = LS.jpeg(LS.build_tiff(gps=False), LS.xmp_packet(gps=False))
        self.assertFalse(mediafile.exif_gps(data, JPEG))
        self.assertEqual(self.strip_ok(data, JPEG), data)

    @unittest.skipIf(Image is None, "Pillow is not installed")
    def test_pillow_reads_the_copy_and_finds_no_gps_and_the_same_picture(self):
        import io
        buf = io.BytesIO()
        Image.new("RGB", (16, 16), (10, 20, 30)).save(buf, "JPEG")
        plain = buf.getvalue()
        data = plain[:2] + LS.segment(0xE1, b"Exif\x00\x00" + LS.build_tiff("<")) + plain[2:]
        self.assertTrue(Image.open(io.BytesIO(data)).getexif().get_ifd(0x8825))
        out = self.strip_ok(data, JPEG)
        exif = Image.open(io.BytesIO(out)).getexif()
        self.assertEqual(dict(exif.get_ifd(0x8825)), {})
        self.assertEqual(exif.get(0x010F), LS.MAKE.decode())
        self.assertEqual(exif.get(0x0112), 6)
        self.assertEqual(list(Image.open(io.BytesIO(out)).convert("RGB").getdata()), list(Image.open(io.BytesIO(plain)).convert("RGB").getdata()))
        self.assertEqual(out[out.index(b"\xff\xda"):], plain[plain.index(b"\xff\xda"):])


class Png(Checks):
    def check_chunks(self, data, out, changed):
        a, b = LS.png_chunks(data), LS.png_chunks(out)
        self.assertEqual([c[0] for c in a], [c[0] for c in b], "the same chunks in the same order")
        for (kind, body, crc, _ok), (_k, body2, crc2, ok2) in zip(a, b):
            self.assertTrue(ok2, "every chunk CRC is valid")
            if kind not in changed:
                self.assertEqual((body, crc), (body2, crc2), "an untouched chunk (IDAT included) is copied as it was")

    def test_exif_gps_is_removed_from_the_exif_chunk(self):
        for order in "<>":
            data = LS.png(tiff=LS.build_tiff(order))
            self.assertTrue(mediafile.exif_gps(data, PNG))
            out = self.strip_ok(data, PNG)
            self.assertClean(out, PNG)
            self.check_chunks(data, out, {b"eXIf"})
            self.assertEqual(len(out), len(data))
            tags = LS.read_tags(dict((c[0], c[1]) for c in LS.png_chunks(out))[b"eXIf"])
            self.assertIsNone(tags["gps"])
            self.assertEqual(tags["ifd0"][0x010F][2], LS.MAKE + b"\x00")

    def test_xmp_gps_is_blanked_plain_and_deflated(self):
        for compress in (False, True):
            for style in ("attribute", "element"):
                data = LS.png(xmp=LS.xmp_packet(style=style), compress_xmp=compress)
                out = self.strip_ok(data, PNG)
                self.assertClean(out, PNG)
                self.check_chunks(data, out, {b"iTXt"})
                body = dict((c[0], c[1]) for c in LS.png_chunks(out))[b"iTXt"]
                text = body[body.index(b"\x00\x00\x00\x00", 18) + 4:] if not compress else None
                if text is not None:
                    self.assertIn(b"exif:DateTimeOriginal", text)
                    self.assertNotIn(b"GPS", text)

    def test_exif_and_xmp_together(self):
        data = LS.png(tiff=LS.build_tiff(), xmp=LS.xmp_packet(), compress_xmp=True)
        out = self.strip_ok(data, PNG)
        self.assertClean(out, PNG)
        self.check_chunks(data, out, {b"eXIf", b"iTXt"})

    def test_a_clean_png_comes_back_as_it_was(self):
        data = LS.png(tiff=LS.build_tiff(gps=False), xmp=LS.xmp_packet(gps=False))
        self.assertEqual(self.strip_ok(data, PNG), data)

    @unittest.skipIf(Image is None, "Pillow is not installed")
    def test_pillow_decodes_the_copy(self):
        import io
        out = self.strip_ok(LS.png(tiff=LS.build_tiff(), xmp=LS.xmp_packet()), PNG)
        image = Image.open(io.BytesIO(out))
        image.load()
        self.assertEqual(image.size, (1, 1))


class FailsClosed(Checks):
    def refused(self, data, ct, reason=None):
        out, why = locstrip.strip(data, ct)
        self.assertIsNone(out)
        self.assertTrue(why)
        if reason:
            self.assertEqual(why, reason)

    def test_a_tiff_is_never_rewritten(self):
        tiff = LS.build_tiff()
        self.assertTrue(mediafile.exif_gps(tiff, "image/tiff"))
        self.refused(tiff, "image/tiff", "tiff")

    def test_other_types_are_not_touched(self):
        self.refused(b"GIF89a....", "image/gif", "unsupported")
        self.refused(b"%PDF-1.4", "application/pdf", "unsupported")

    def test_a_gps_pointer_to_nowhere_is_not_guessed_at(self):
        tiff = bytearray(LS.build_tiff())
        n = struct.unpack_from("<H", tiff, 8)[0]
        for i in range(n):
            if struct.unpack_from("<H", tiff, 10 + 12 * i)[0] == 0x8825:
                struct.pack_into("<I", tiff, 10 + 12 * i + 8, 0x00FFFFF0)
        self.refused(LS.jpeg(bytes(tiff)), JPEG)

    def test_an_unknown_value_type_in_the_gps_ifd_is_refused(self):
        tiff = bytearray(LS.build_tiff())
        gps_at = struct.unpack_from("<I", tiff, 10 + 12 * 4 + 8)[0]          # IFD0's fifth entry is the GPS pointer
        struct.pack_into("<H", tiff, gps_at + 2 + 2, 99)                        # the first GPS entry's type
        self.refused(LS.jpeg(bytes(tiff)), JPEG)

    def test_truncated_segments_and_missing_scans_are_refused(self):
        data = LS.jpeg(LS.build_tiff())
        self.refused(data[:data.index(b"Exif") + 20], JPEG)
        self.refused(data[:LS.scan_start(data)], JPEG)
        self.refused(b"\xff\xd8", JPEG)
        self.refused(LS.png(tiff=LS.build_tiff())[:-5], PNG)
        self.refused(b"\x89PNG\r\n\x1a\n", PNG)

    def test_extended_xmp_and_raw_profile_text_with_a_position_stay_held(self):
        ext = LS.segment(0xE1, b"http://ns.adobe.com/xmp/extension/\x00" + b"0" * 40 + b'exif:GPSLatitude="1,2N"')
        self.refused(LS.jpeg(LS.build_tiff(), extra_segments=ext), JPEG)
        self.refused(LS.png(tiff=LS.build_tiff(), text=b"Raw profile type exif\x00hex"), PNG)

    def test_a_gps_word_in_a_comment_keeps_the_photo_held(self):
        data = LS.jpeg(LS.build_tiff(), extra_segments=LS.segment(0xFE, b"taken with the GPS Cam"))
        self.refused(data, JPEG, "verify_failed")

    def test_a_looping_ifd_is_refused(self):
        tiff = bytearray(LS.build_tiff(thumb=LS.jpeg()))
        ifd1 = struct.unpack_from("<I", tiff, 8 + 2 + 12 * 5)[0]                # IFD0's next-IFD offset
        n1 = struct.unpack_from("<H", tiff, ifd1)[0]
        struct.pack_into("<I", tiff, ifd1 + 2 + 12 * n1, 8)                     # IFD1 points back at IFD0
        self.refused(LS.jpeg(bytes(tiff)), JPEG)


class Fuzz(Checks):
    """Truncated and garbled files: the strip never raises, and never returns a copy that still has a position."""

    def run_one(self, data, ct):
        try:
            out, reason = locstrip.strip(data, ct)
        except BaseException as exc:                                     # noqa: BLE001
            self.fail("strip raised %s" % type(exc).__name__)
        if out is None:
            self.assertTrue(reason)
            return False
        self.assertFalse(mediafile.exif_gps(out, ct))
        self.assertFalse(locstrip.has_location_residue(out, ct))
        # Orphaned coordinate bytes with no pointer or property name left to them (a garble can cut the pointer of an intact GPS IFD) are not a
        # position any reader can find; the deterministic tests above look for the bytes themselves. Here the guarantee is the two scans.
        return True

    def bases(self):
        thumb = thumbnail()
        scan2 = LS.segment(0xFE, b"between the scans") + b"\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00" + b"\x11\x22\x33"
        progressive = LS.jpeg(LS.build_tiff(), LS.xmp_packet())[:-2] + scan2 + b"\xff\xd9"
        icc = LS.segment(0xE2, b"ICC_PROFILE\x00\x01\x01" + b"acsp" * 16) + LS.segment(0xEE, b"Adobe\x00\x64\x00\x00\x00\x00\x01")
        return [(LS.jpeg(LS.build_tiff(), LS.xmp_packet()), JPEG), (LS.jpeg(LS.build_tiff(">", thumb=thumb), LS.xmp_packet(style="element")), JPEG),
                (progressive, JPEG), (LS.jpeg(LS.build_tiff(">"), LS.xmp_packet(), extra_segments=icc), JPEG),
                (LS.png(tiff=LS.build_tiff(), xmp=LS.xmp_packet(), compress_xmp=True), PNG), (LS.png(tiff=LS.build_tiff(">"), xmp=LS.xmp_packet()), PNG)]

    def test_every_truncation_is_refused_or_clean(self):
        for data, ct in self.bases():
            for cut in range(len(data)):
                self.run_one(data[:cut], ct)

    def test_garbled_bytes_never_leave_a_position_behind(self):
        rng = random.Random(374)
        bases = self.bases()
        kept = 0
        for _ in range(6000):
            data, ct = rng.choice(bases)
            buf = bytearray(data)
            for _k in range(rng.randint(1, 8)):
                kind = rng.random()
                at = rng.randrange(len(buf))
                if kind < 0.6:
                    buf[at] = rng.randrange(256)
                elif kind < 0.8:
                    del buf[at:at + rng.randint(1, 6)]
                else:
                    buf[at:at] = bytes(rng.randrange(256) for _ in range(rng.randint(1, 6)))
            kept += self.run_one(bytes(buf), ct)
        self.assertGreater(kept, 0, "some garbled files are still taken: the fuzz exercised the success path as well")

    def test_pure_noise_after_a_valid_signature(self):
        rng = random.Random(7)
        for _ in range(500):
            noise = bytes(rng.randrange(256) for _ in range(rng.randint(0, 300)))
            self.run_one(b"\xff\xd8" + noise, JPEG)
            self.run_one(b"\x89PNG\r\n\x1a\n" + noise, PNG)


if __name__ == "__main__":
    unittest.main()
