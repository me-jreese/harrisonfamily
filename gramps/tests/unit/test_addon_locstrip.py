"""The minimal-metadata copy (HFY-TSK-374): a JPEG or PNG is rebuilt from an allowlist, or it is not copied at all.

    cd gramps/tests/unit && python3 -m unittest test_addon_locstrip

Every image here is built from fabricated bytes and a fabricated position (locstrip_support.py); no real photo is read. The copy keeps the
picture-side parts byte for byte, a rebuilt JFIF/Adobe header, an Exif with the Orientation tag alone, and a checked ICC profile; everything
else is dropped. Pillow, when it is installed, decodes the copies as a second opinion; nothing needs it. Python 3.9 compatible.
"""
import hashlib
import io
import os
import random
import struct
import sys
import unittest
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))

import locstrip_support as LS  # noqa: E402
from hfygramps.addon import locstrip, mediafile  # noqa: E402

try:
    from PIL import Image, ImageCms
except ImportError:  # pragma: no cover - optional second opinion
    Image = ImageCms = None

JPEG, PNG = "image/jpeg", "image/png"
PICTURE_JPEG = lambda parts: [(m, p) for m, p in parts if m is None or m in locstrip._STRUCTURAL]  # noqa: E731
PICTURE_PNG = lambda chunks: [(k, b) for k, b, _c in chunks if k in locstrip._PNG_COPIED]  # noqa: E731
EXTRA = (LS.segment(0xFE, b"a comment") + LS.segment(0xED, b"Photoshop 3.0\x00" + b"8BIM\x04\x04\x00\x00\x00\x00\x00\x04" + b"abcd")
         + LS.segment(0xE3, b"META\x00\x00" + b"x" * 30) + LS.segment(0xE0, b"JFXX\x00\x10" + b"t" * 20) + LS.segment(0xE2, b"MPF\x00" + b"\x00" * 16))


def thumbnail(order="<"):
    return LS.jpeg(LS.build_tiff(order, gps=True))


class Checks(unittest.TestCase):
    def strip_ok(self, data, ct):
        before = hashlib.sha256(data).hexdigest()
        out, reason = locstrip.strip(data, ct)
        self.assertEqual(hashlib.sha256(data).hexdigest(), before, "the input is never changed")
        self.assertIsNotNone(out, reason)
        self.assertEqual(reason, "")
        self.assertFalse(mediafile.exif_gps(out, ct), "the add-on's detector finds nothing in the copy")
        self.assertFalse(locstrip.has_location_residue(out, ct), "and neither does the list-based scan")
        for token in LS.coordinate_bytes():
            self.assertNotIn(token, out, "no coordinate bytes are left in the file")
        return out

    def jpeg_kinds(self, out):
        return [m for m, _p in locstrip._jpeg_parts(out) if m is not None and m not in locstrip._STRUCTURAL]


class Jpeg(Checks):
    def test_the_copy_is_the_minimal_one_and_the_picture_parts_are_the_originals(self):
        for order in "<>":
            data = LS.jpeg(LS.build_tiff(order, thumb=thumbnail(order)), LS.xmp_packet(), extra_segments=EXTRA)
            out = self.strip_ok(data, JPEG)
            self.assertEqual(self.jpeg_kinds(out), [0xE0, 0xE1], "a JFIF and an Exif, nothing else")
            self.assertEqual(PICTURE_JPEG(locstrip._jpeg_parts(out)), PICTURE_JPEG(locstrip._jpeg_parts(data)), "tables, scan data: byte for byte")
            self.assertLess(len(out), len(data))
            exif = dict(locstrip._jpeg_parts(out))[0xE1]
            self.assertEqual(exif, b"Exif\x00\x00" + locstrip._exif_tiff(order, 6), "Orientation, in the original's byte order, and nothing else")
            self.assertEqual(out[out.rindex(b"\xff\xda"):], data[data.rindex(b"\xff\xda"):], "from the scan header to the end the bytes are the original's")

    def test_no_orientation_no_exif_and_an_invalid_one_is_no_orientation(self):
        no_orientation = LS.assemble("<", [("ifd0", [LS.asc("<", 0x010F, LS.MAKE)], None)], {})
        self.assertNotIn(0xE1, self.jpeg_kinds(self.strip_ok(LS.jpeg(no_orientation), JPEG)))
        for typ, count, value in ((3, 1, 9), (3, 1, 0), (4, 1, 6), (3, 2, 6)):
            tiff = LS.assemble("<", [("ifd0", [(0x0112, typ, count, struct.pack("<I" if typ == 4 else "<HH", *((value,) if typ == 4 else (value, 0))))], None)], {})
            self.assertNotIn(0xE1, self.jpeg_kinds(self.strip_ok(LS.jpeg(tiff), JPEG)), (typ, count, value))

    def test_every_other_part_is_dropped_and_the_dropped_content_does_not_survive(self):
        data = LS.jpeg(LS.build_tiff(), LS.xmp_packet(), extra_segments=EXTRA + LS.segment(0xFE, b"taken at 37.5712 -122.0809"))
        out = self.strip_ok(data, JPEG)
        for dropped in (b"a comment", b"Photoshop", b"META", b"JFXX", b"MPF", b"xmpmeta", b"SYNTHCAM", b"SYNTHMAKERNOTE", b"37.5712", b"2001:02:03"):
            self.assertNotIn(dropped, out)

    def test_jfif_is_rebuilt_without_a_thumbnail_and_adobe_is_kept(self):
        jfif = LS.segment(0xE0, b"JFIF\x00\x01\x02\x01\x00\x48\x00\x48\x02\x02" + b"\x11" * 12)
        adobe = LS.segment(0xEE, b"Adobe\x00\x64\x00\x00\x00\x00\x01" + b"junk")
        data = LS.jpeg(None, extra_segments=adobe).replace(LS.JFIF, b"\xff\xd8" + jfif, 1)
        out = self.strip_ok(data, JPEG)
        parts = dict(locstrip._jpeg_parts(out))
        self.assertEqual(parts[0xE0], b"JFIF\x00\x01\x02\x01\x00\x48\x00\x48\x00\x00", "version, units, densities kept; thumbnail size 0, no thumbnail")
        self.assertEqual(parts[0xEE], b"Adobe\x00\x64\x00\x00\x00\x00\x01")

    def test_a_progressive_file_keeps_every_scan(self):
        plain = LS.jpeg(LS.build_tiff(), body=LS.PROGRESSIVE)
        first = plain.index(b"\xff\xda")
        second = plain.index(b"\xff\xda", first + 2)
        data = plain[:second] + LS.segment(0xFE, b"between") + plain[second:]
        out = self.strip_ok(data, JPEG)
        self.assertEqual(PICTURE_JPEG(locstrip._jpeg_parts(out)), PICTURE_JPEG(locstrip._jpeg_parts(data)))
        self.assertGreater(len([1 for m, _p in locstrip._jpeg_parts(out) if m == 0xDA]), 3, "every scan of the progressive file is in the copy")
        self.assertNotIn(b"between", out)

    def test_trailing_zero_padding_is_not_a_second_picture(self):
        self.strip_ok(LS.jpeg(LS.build_tiff()) + b"\x00" * 9, JPEG)

    def test_an_icc_profile_is_kept_byte_for_byte_also_in_pieces(self):
        for profile, size in ((LS.icc_profile(), 65000), (LS.icc_profile(text_kind="text"), 65000), (LS.icc_profile(text_kind="desc"), 65000),
                              (LS.icc_profile(), 200)):
            data = LS.jpeg(LS.build_tiff(), extra_segments=LS.icc_segments(profile, size))
            out = self.strip_ok(data, JPEG)
            self.assertIn(0xE2, self.jpeg_kinds(out))
            self.assertEqual(locstrip._icc_of_jpeg(locstrip._jpeg_parts(out)), profile)

    def test_an_icc_profile_the_add_on_does_not_accept_holds_the_photo(self):
        bad = {
            "a coordinate in the description": LS.icc_profile(desc="Shot at 12.3456, 65.4321"),
            "a position word": LS.icc_profile(desc="Latitude profile"),
            "a long number": LS.icc_profile(desc="Profile 1234567890"),
            "a text outside the alphabet": LS.icc_profile(cprt="by <someone>; 12 N"),
            "a coordinate in a text tag": LS.icc_profile(text_kind="text", cprt="N12.3460 E65.4330"),
            "an unknown tag type": LS.icc_profile(extra_tag=(b"zzzz", b"data\x00\x00\x00\x00" + b"II*\x00" + b"x" * 20)),
            "an xml dict": LS.icc_profile(extra_tag=(b"meta", b"dict\x00\x00\x00\x00" + b"x" * 12)),
            "bytes between the tags": LS.icc_profile(gap=b"\x00\x00\x00\x00hidden text 12.3456"),
            "a wrong size field": LS.icc_profile(size_lie=4),
        }
        for label, profile in bad.items():
            out, reason = locstrip.strip(LS.jpeg(LS.build_tiff(), extra_segments=LS.icc_segments(profile)), JPEG)
            self.assertEqual((out, reason), (None, "icc"), label)
        broken = LS.segment(0xE2, b"ICC_PROFILE\x00\x01\x02" + LS.icc_profile())          # chunk 1 of 2, chunk 2 missing
        self.assertEqual(locstrip.strip(LS.jpeg(LS.build_tiff(), extra_segments=broken), JPEG), (None, "icc"))

    @unittest.skipIf(Image is None, "Pillow is not installed")
    def test_a_phone_style_photo_keeps_its_orientation_and_its_real_icc_profile_and_pillow_reads_the_copy(self):
        buf = io.BytesIO()
        profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
        Image.new("RGB", (16, 16), (10, 20, 30)).save(buf, "JPEG", icc_profile=profile)
        plain = buf.getvalue()
        after_soi = plain[:2]
        rest = plain[2:]
        data = after_soi + LS.segment(0xE1, b"Exif\x00\x00" + LS.build_tiff("<", thumb=thumbnail())) + LS.segment(0xE1, b"http://ns.adobe.com/xap/1.0/\x00" + LS.xmp_packet()) + rest
        self.assertTrue(Image.open(io.BytesIO(data)).getexif().get_ifd(0x8825))
        out = self.strip_ok(data, JPEG)
        image = Image.open(io.BytesIO(out))
        exif = image.getexif()
        self.assertEqual((exif.get(0x0112), dict(exif.get_ifd(0x8825)), exif.get(0x010F)), (6, {}, None), "Orientation only")
        self.assertEqual(image.info.get("icc_profile"), profile, "the colour profile is the original's")
        self.assertEqual(list(image.convert("RGB").getdata()), list(Image.open(io.BytesIO(plain)).convert("RGB").getdata()), "the same pixels")
        self.assertNotIn("xmp", image.info)


class Png(Checks):
    def kinds(self, out):
        return [k for k, _b, _c in locstrip._chunks(out)]

    def test_the_copy_is_the_minimal_one_and_the_picture_chunks_are_the_originals(self):
        for order in "<>":
            extra = (LS.chunk(b"gAMA", struct.pack(">I", 45455)) + LS.chunk(b"pHYs", struct.pack(">IIB", 2835, 2835, 1)) + LS.chunk(b"tIME", struct.pack(">HBBBBB", 2001, 2, 3, 4, 5, 6))
                     + LS.chunk(b"sPLT", b"name\x00\x08" + b"\x00" * 6) + LS.chunk(b"zxIf", b"\x00" + zlib.compress(LS.build_tiff(">"))) + LS.chunk(b"vpAg", b"\x00" * 9))
            data = LS.png(tiff=LS.build_tiff(order), xmp=LS.xmp_packet(), compress_xmp=True, text=b"Comment\x00at 37.5712 -122.0809", icc=LS.icc_profile(), extra=extra)
            out = self.strip_ok(data, PNG)
            self.assertEqual(self.kinds(out), [b"IHDR", b"iCCP", b"gAMA", b"pHYs", b"eXIf", b"IDAT", b"IEND"])
            self.assertEqual(PICTURE_PNG(locstrip._chunks(out)), PICTURE_PNG(locstrip._chunks(data)))
            self.assertTrue(all(c[3] for c in LS.png_chunks(out)), "every CRC is valid")
            self.assertEqual(dict((k, b) for k, b, _c in locstrip._chunks(out))[b"eXIf"], locstrip._exif_tiff(order, 6))
            for dropped in (b"tEXt", b"iTXt", b"tIME", b"sPLT", b"zxIf", b"vpAg", b"37.5712", b"xmpmeta"):
                self.assertNotIn(dropped, out)

    def test_an_exif_prefix_in_the_chunk_is_read_and_no_orientation_means_no_chunk(self):
        out = self.strip_ok(LS.png(tiff=b"Exif\x00\x00" + LS.build_tiff("<")), PNG)
        self.assertEqual(dict((k, b) for k, b, _c in locstrip._chunks(out))[b"eXIf"], locstrip._exif_tiff("<", 6))
        no_orientation = LS.assemble("<", [("ifd0", [LS.asc("<", 0x010F, LS.MAKE)], None)], {})
        self.assertNotIn(b"eXIf", self.kinds(self.strip_ok(LS.png(tiff=no_orientation), PNG)))

    def test_an_iccp_that_is_not_accepted_holds_the_photo(self):
        for profile in (LS.icc_profile(desc="Shot at 12.3456, 65.4321"), LS.icc_profile(extra_tag=(b"zzzz", b"data\x00\x00\x00\x00" + b"x" * 12))):
            self.assertEqual(locstrip.strip(LS.png(tiff=LS.build_tiff(), icc=profile), PNG), (None, "icc"))
        bad_keyword = LS.chunk(b"iCCP", b"12.3456, 65.4321\x00\x00" + zlib.compress(LS.icc_profile()))
        data = LS.png(tiff=LS.build_tiff())
        self.assertEqual(locstrip.strip(data[:33] + bad_keyword + data[33:], PNG), (None, "icc"))

    @unittest.skipIf(Image is None, "Pillow is not installed")
    def test_pillow_decodes_the_copy_and_reads_the_orientation(self):
        out = self.strip_ok(LS.png(tiff=LS.build_tiff(), xmp=LS.xmp_packet(), icc=LS.icc_profile()), PNG)
        image = Image.open(io.BytesIO(out))
        image.load()
        self.assertEqual((image.size, image.getexif().get(0x0112), dict(image.getexif().get_ifd(0x8825))), ((1, 1), 6, {}))
        self.assertEqual(image.info.get("icc_profile"), LS.icc_profile())


class FailsClosed(Checks):
    def refused(self, data, ct, reason=None):
        out, why = locstrip.strip(data, ct)
        self.assertIsNone(out)
        self.assertTrue(why)
        if reason:
            self.assertEqual(why, reason)
        self.assertIsNone(mediafile.strip_copy(data, ct)[0])

    def test_a_tiff_is_never_rewritten_and_other_types_are_not_touched(self):
        self.refused(LS.build_tiff(), "image/tiff", "tiff")
        self.refused(b"GIF89a....", "image/gif", "unsupported")
        self.refused(b"%PDF-1.4", "application/pdf", "unsupported")

    def test_a_jpeg_it_cannot_follow_is_held(self):
        data = LS.jpeg(LS.build_tiff())
        self.refused(data[:data.index(b"Exif") + 20], JPEG)                  # a cut segment
        self.refused(data[:LS.scan_start(data)], JPEG)                         # no scan
        self.refused(data[:-2], JPEG)                                          # no end of image
        self.refused(b"\xff\xd8", JPEG)
        self.refused(data + b"x", JPEG)                                        # a byte after the end of the image
        self.refused(data + LS.jpeg(LS.build_tiff(gps=False)), JPEG)           # a second picture
        for marker in (0x02, 0xC8, 0xF0, 0xD0, 0xD8, 0x01):                    # reserved, JPG, JPGn, RST outside a scan, SOI, TEM
            self.refused(LS.jpeg(LS.build_tiff(), extra_segments=b"\xff" + bytes([marker]) + b"\x00\x04ab"), JPEG)

    def test_an_exif_it_cannot_read_to_its_orientation_holds_the_photo(self):
        tiff = bytearray(LS.build_tiff("<"))
        ifd0 = struct.unpack_from("<I", tiff, 4)[0]
        struct.pack_into("<H", tiff, ifd0, 65535)
        self.refused(LS.jpeg(bytes(tiff)), JPEG)
        self.refused(LS.png(tiff=bytes(tiff)), PNG)
        twice = LS.assemble("<", [("ifd0", [(0x0112, 3, 1, struct.pack("<HH", 6, 0)), (0x0112, 3, 1, struct.pack("<HH", 3, 0))], None)], {})
        self.refused(LS.jpeg(twice), JPEG)
        self.refused(LS.jpeg(b"MM\x00*" + b"\x00" * 3), JPEG)               # not a TIFF at all

    def test_a_png_it_cannot_follow_is_held(self):
        data = LS.png(tiff=LS.build_tiff())
        iend = data.rindex(b"IEND") - 4
        self.refused(data[:-5], PNG)
        self.refused(b"\x89PNG\r\n\x1a\n", PNG)
        self.refused(data + b"\x00", PNG)                                      # a byte after IEND
        self.refused(data + LS.build_tiff(">"), PNG)
        bad = bytearray(data)
        bad[-20] ^= 1
        self.refused(bytes(bad), PNG)                                          # a wrong CRC
        self.refused(data[:iend] + LS.chunk(b"Zzzz", b"x") + data[iend:], PNG)  # an unknown CRITICAL chunk
        for kind in (b"acTL", b"fcTL", b"fdAT"):                               # an animation: dropping frames would change the picture
            self.refused(data[:iend] + LS.chunk(kind, b"\x00" * 8) + data[iend:], PNG)
        self.refused(data[:iend] + LS.chunk(b"gAMA", b"\x00") + data[iend:], PNG)  # a fixed-size chunk of the wrong size

    def test_the_copy_of_a_clean_file_is_made_the_same_way(self):
        out = self.strip_ok(LS.jpeg(LS.build_tiff(gps=False), LS.xmp_packet(gps=False)), JPEG)
        self.assertEqual(self.jpeg_kinds(out), [0xE0, 0xE1])


class Fuzz(Checks):
    """Truncated and garbled files: the strip never raises, and never returns a copy that a scan finds a position in or that still holds the
    original's coordinate bytes."""

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
        for token in LS.coordinate_bytes():
            self.assertNotIn(token, out)
        return True

    def bases(self):
        thumb = thumbnail()
        scan2 = LS.segment(0xFE, b"between the scans") + b"\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00" + b"\x11\x22\x33"
        progressive = LS.jpeg(LS.build_tiff(), LS.xmp_packet())[:-2] + scan2 + b"\xff\xd9"
        icc = LS.icc_segments(LS.icc_profile()) + LS.segment(0xEE, b"Adobe\x00\x64\x00\x00\x00\x00\x01")
        return [(LS.jpeg(LS.build_tiff(), LS.xmp_packet(), extra_segments=EXTRA), JPEG), (LS.jpeg(LS.build_tiff(">", thumb=thumb), LS.xmp_packet(style="element")), JPEG),
                (progressive, JPEG), (LS.jpeg(LS.build_tiff(">"), LS.xmp_packet(), extra_segments=icc), JPEG),
                (LS.png(tiff=LS.build_tiff(), xmp=LS.xmp_packet(), compress_xmp=True, icc=LS.icc_profile()), PNG),
                (LS.png(tiff=LS.build_tiff(">"), xmp=LS.xmp_packet(), text=b"Comment\x00hello"), PNG)]

    def test_every_truncation_is_refused_or_clean(self):
        for data, ct in self.bases():
            for cut in range(len(data)):
                self.run_one(data[:cut], ct)

    def test_garbled_bytes_never_leave_a_position_behind(self):
        rng = random.Random(374)
        bases = self.bases()
        kept = 0
        for _ in range(8000):
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
