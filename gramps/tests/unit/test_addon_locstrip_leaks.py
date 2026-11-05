"""What an adversarial review of the location strip found (HFY-TSK-374): a copy must not carry a position in any place a file can hold one.

    cd gramps/tests/unit && python3 -m unittest test_addon_locstrip_leaks

Each case is a synthetic file built here from fabricated bytes and a fabricated position (locstrip_support.py), shaped like one repro of the
review: a TIFF behind a trailer, a motion-photo video, an IRB, a METADATA segment, an ``Exif\\0\\xff`` header, UTF-16 XMP between scans, extended
XMP split inside a name, PNG chunks the strip does not know, a regular expression bomb, an inflate bomb. The strip must HOLD (return no copy)
or return a copy in which two scans find nothing. The second half is the add-on's detector: a photo whose position only sits in a place the
older detector did not read is now found, so it is held with the setting off and stripped (or held) with it on.
Standard library only; Python 3.9 compatible.
"""
import os
import struct
import sys
import time
import tracemalloc
import unittest
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))

import locstrip_support as LS  # noqa: E402
from hfygramps.addon import locstrip, mediafile  # noqa: E402

JPEG, PNG = "image/jpeg", "image/png"
GPS_XMP_ATTR = b' exif:GPSLatitude="37,33.4242N" exif:GPSLongitude="122,4.5151W"'


def tiff_main():
    return LS.build_tiff("<")


def raw_tiff():
    return LS.build_tiff(">")


def eoi_split(data):
    """(everything before EOI, EOI): a JPEG built by LS.jpeg ends with EOI."""
    assert data.endswith(b"\xff\xd9")
    return data[:-2], b"\xff\xd9"


SOS = b"\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00"


def second_scan(extra_segment, scan=b"\x11\x22\x33"):
    """A progressive file: the first scan, a segment between the scans, and a second scan."""
    body, eoi = eoi_split(LS.jpeg(tiff_main()))
    return body + extra_segment + SOS + scan + eoi


def mp4_with_location():
    atom = b"\xa9xyz" + struct.pack(">HH", 18, 0x15C7) + b"+37.5712-122.0809/"
    udta = struct.pack(">I", 8 + len(atom)) + b"udta" + atom
    moov = struct.pack(">I", 8 + len(udta)) + b"moov" + udta
    return struct.pack(">I", 24) + b"ftypmp42" + b"\x00\x00\x00\x00mp42isom" + moov


def utf16(text):
    return text.decode("latin-1").encode("utf-16-be")


class Holds(unittest.TestCase):
    """Files the strip must not turn into a copy: no copy, or a copy with nothing left (checked by two scans and a byte search)."""

    def assertHeld(self, data, ct, why=""):
        out, reason = locstrip.strip(data, ct)
        self.assertIsNone(out, why)
        self.assertTrue(reason)
        out2, _reason2 = mediafile.strip_copy(data, ct)
        self.assertIsNone(out2, why)

    def assertClean(self, data, ct):
        out, reason = locstrip.strip(data, ct)
        self.assertIsNotNone(out, reason)
        self.assertFalse(mediafile.exif_gps(out, ct))
        self.assertFalse(locstrip.has_location_residue(out, ct))
        for token in LS.coordinate_bytes()[:4]:
            self.assertNotIn(token, out)
        return out

    # ---- JPEG: data outside the top-level Exif APP1
    def test_a_raw_tiff_with_a_position_after_the_end_of_the_image(self):
        self.assertHeld(LS.jpeg(tiff_main()) + b"GARBAGE" + raw_tiff(), JPEG)
        self.assertHeld(LS.jpeg(tiff_main()) + b"GARBAGE" + b"Exif\x00\x00" + raw_tiff(), JPEG)

    def test_a_motion_photo_video_after_the_image_holds_it(self):
        self.assertHeld(LS.jpeg(tiff_main()) + mp4_with_location(), JPEG)
        self.assertTrue(mediafile.exif_gps(LS.jpeg(None) + mp4_with_location(), JPEG), "a location atom alone is a position")

    def test_a_second_picture_after_the_end_of_the_image_holds_it(self):
        second = LS.jpeg(LS.build_tiff(">", gps=False))
        self.assertHeld(LS.jpeg(tiff_main()) + second, JPEG)

    def test_trailing_zero_padding_is_not_a_second_picture(self):
        self.assertClean(LS.jpeg(tiff_main()) + b"\x00" * 16, JPEG)

    def test_a_raw_tiff_in_a_photoshop_resource_or_a_meta_segment(self):
        irb = b"8BIM\x04\x22\x00\x00" + struct.pack(">I", len(raw_tiff())) + raw_tiff() + (b"\x00" if len(raw_tiff()) & 1 else b"")
        self.assertHeld(LS.jpeg(tiff_main(), extra_segments=LS.segment(0xED, b"Photoshop 3.0\x00" + irb)), JPEG)
        self.assertHeld(LS.jpeg(tiff_main(), extra_segments=LS.segment(0xE3, b"META\x00\x00" + raw_tiff())), JPEG)
        self.assertHeld(LS.jpeg(tiff_main(), extra_segments=LS.segment(0xE1, b"FOOB\x00\x00" + raw_tiff())), JPEG)

    def test_a_segment_the_strip_cannot_name_holds_the_photo(self):
        for marker in (0xE3, 0xE4, 0xEB, 0xEF):
            self.assertHeld(LS.jpeg(tiff_main(), extra_segments=LS.segment(marker, b"VENDOR\x00" + b"x" * 20)), JPEG)
        self.assertHeld(LS.jpeg(tiff_main(), extra_segments=LS.segment(0xEB, b"JP\x00\x01" + b'{"exif:GPSLatitude":"1,2N"}')), JPEG)

    def test_the_segments_a_camera_writes_are_accepted(self):
        extra = (LS.segment(0xE2, b"ICC_PROFILE\x00\x01\x01" + b"acsp" * 20) + LS.segment(0xEE, b"Adobe\x00\x64\x00\x00\x00\x00\x01")
                 + LS.segment(0xE2, b"MPF\x00" + b"\x00" * 16) + LS.segment(0xFE, b"a plain comment"))
        self.assertClean(LS.jpeg(tiff_main(), LS.xmp_packet(), extra_segments=extra), JPEG)

    def test_a_thumbnail_whose_exif_header_is_not_the_usual_one(self):
        thumb = LS.jpeg(None, extra_segments=LS.segment(0xE1, b"Exif\x00\xff" + LS.build_tiff(">", gps=True)))
        self.assertHeld(LS.jpeg(LS.build_tiff("<", thumb=thumb)), JPEG)
        self.assertHeld(LS.jpeg(tiff_main(), extra_segments=LS.segment(0xE1, b"Exif\x00\xff" + raw_tiff())), JPEG)

    def test_utf16_xmp_between_the_scans_or_after_the_image(self):
        xmp = LS.segment(0xE1, b"http://ns.adobe.com/xap/1.0/\x00" + utf16(LS.xmp_packet()))
        self.assertHeld(second_scan(xmp), JPEG)
        self.assertHeld(LS.jpeg(tiff_main()) + xmp, JPEG)
        self.assertHeld(LS.jpeg(tiff_main(), extra_segments=xmp), JPEG)

    def test_a_progressive_file_with_a_clean_segment_between_the_scans_is_taken(self):
        self.assertClean(second_scan(LS.segment(0xFE, b"between the scans")), JPEG)

    def test_an_exif_between_the_scans_is_cleaned_too(self):
        data = second_scan(LS.segment(0xE1, b"Exif\x00\x00" + raw_tiff()))
        self.assertTrue(mediafile.exif_gps(data, JPEG))
        self.assertClean(data, JPEG)

    # ---- JPEG: extended XMP
    def test_extended_xmp_holds_the_photo_whole_or_split_inside_a_name(self):
        ext = (b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description '
               b'xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="37,33.4242N" exif:GPSLongitude="122,4.5151W"/></rdf:RDF></x:xmpmeta>')
        guid = b"0123456789ABCDEF0123456789ABCDEF"
        cut = ext.index(b"GPSLatitude") + 1
        whole = [LS.segment(0xE1, locstrip._XMP_EXT_NS + guid + struct.pack(">II", len(ext), 0) + ext)]
        split = [LS.segment(0xE1, locstrip._XMP_EXT_NS + guid + struct.pack(">II", len(ext), off) + part)
                 for off, part in ((0, ext[:cut]), (cut, ext[cut:]))]
        main = LS.xmp_packet(gps=False)
        for segs in (whole, split):
            self.assertHeld(LS.jpeg(tiff_main(), main, extra_segments=b"".join(segs)), JPEG)

    def test_standard_xmp_split_over_two_segments_holds_the_photo(self):
        xmp = LS.xmp_packet()
        cut = xmp.index(b"GPSLatitude") + 1
        two = LS.segment(0xE1, b"http://ns.adobe.com/xap/1.0/\x00" + xmp[:cut]) + LS.segment(0xE1, xmp[cut:])
        self.assertHeld(LS.jpeg(tiff_main(), extra_segments=two), JPEG)

    # ---- free text and XMP forms
    def test_bare_coordinates_in_a_comment_hold_the_photo(self):
        self.assertHeld(LS.jpeg(tiff_main(), extra_segments=LS.segment(0xFE, b"taken at 37.5712 -122.0809")), JPEG)
        self.assertHeld(LS.jpeg(tiff_main(), extra_segments=LS.segment(0xFE, b"37 deg 34' north")), JPEG)
        self.assertClean(LS.jpeg(tiff_main(), extra_segments=LS.segment(0xFE, b"my grandmother's house, 1951")), JPEG)

    def test_an_entity_or_doctype_in_xmp_holds_the_photo(self):
        xmp = LS.xmp_packet(gps=False).replace(b"<x:xmpmeta", b'<!DOCTYPE x [<!ENTITY lat "37,33.4242N">]><x:xmpmeta', 1)
        self.assertHeld(LS.jpeg(tiff_main(), xmp), JPEG)

    def test_xmp_with_a_nested_same_name_property_holds_the_photo(self):
        body = b"<exif:GPSLatitude><exif:GPSLatitude>37,33N</exif:GPSLatitude></exif:GPSLatitude>"
        xmp = LS.xmp_packet(gps=False).replace(b"</rdf:Description>", body + b"</rdf:Description>", 1)
        self.assertHeld(LS.jpeg(tiff_main(), xmp), JPEG)

    def test_dji_names_are_blanked(self):
        xmp = LS.xmp_packet(gps=False).replace(b' exif:DateTimeOriginal', b' drone-dji:GpsLatitude="37.5712" drone-dji:GpsLongtitude="-122.0809" exif:DateTimeOriginal', 1)
        out = self.assertClean(LS.jpeg(tiff_main(), xmp), JPEG)
        self.assertNotIn(b"Gps", out)

    # ---- PNG
    def test_png_chunks_the_strip_does_not_know_hold_the_photo(self):
        main = LS.chunk(b"eXIf", tiff_main())
        base = LS.png(tiff=tiff_main())
        iend = base.rindex(b"IEND") - 4
        for kind, body in ((b"zxIf", b"\x00" + zlib.compress(raw_tiff())), (b"exIf", raw_tiff()), (b"vpAg", b"\x00" * 9)):
            self.assertHeld(base[:iend] + LS.chunk(kind, body) + base[iend:], PNG, kind)
        self.assertHeld(base + raw_tiff(), PNG, "bytes after IEND")
        self.assertHeld(base + b"Exif\x00\x00" + raw_tiff(), PNG, "an Exif block after IEND")
        self.assertHeld(base + b"\x00", PNG, "one byte after IEND")
        self.assertTrue(main)

    def test_a_png_with_a_wrong_chunk_crc_holds_the_photo(self):
        data = bytearray(LS.png(tiff=tiff_main()))
        data[-20] ^= 0x01
        self.assertHeld(bytes(data), PNG)

    def test_a_png_text_chunk_with_a_position_or_a_raw_profile_holds_the_photo(self):
        hexed = b"\nexif\n%8d\n" % (6 + len(raw_tiff())) + (b"Exif\x00\x00" + raw_tiff()).hex().encode()
        self.assertHeld(LS.png(tiff=tiff_main(), text=b"Raw profile type exif\x00" + hexed), PNG)
        self.assertHeld(LS.png(tiff=tiff_main(), text=b"Comment\x00at 37.5712,-122.0809"), PNG)
        self.assertClean(LS.png(tiff=tiff_main(), text=b"Comment\x00a plain comment"), PNG)

    def test_the_standard_png_chunks_are_accepted(self):
        data = LS.png(tiff=tiff_main(), xmp=LS.xmp_packet())
        iend = data.rindex(b"IEND") - 4
        extra = (LS.chunk(b"gAMA", struct.pack(">I", 45455)) + LS.chunk(b"sRGB", b"\x00") + LS.chunk(b"pHYs", struct.pack(">IIB", 2835, 2835, 1))
                 + LS.chunk(b"tIME", struct.pack(">HBBBBB", 2001, 2, 3, 4, 5, 6)) + LS.chunk(b"bKGD", b"\x80"))
        self.assertClean(data[:iend] + extra + data[iend:], PNG)

    # ---- bounded work
    def test_a_regular_expression_bomb_is_refused_at_once(self):
        def bomb(n):
            return LS.xmp_packet(gps=False).replace(b"</rdf:Description>", b"<gpsa>" * n + b"</rdf:Description>", 1)
        cases = ((LS.png(tiff=tiff_main(), xmp=bomb(128000), compress_xmp=True), PNG), (LS.jpeg(tiff_main(), bomb(10500)), JPEG))
        for data, ct in cases:
            t0 = time.time()
            out, _why = locstrip.strip(data, ct)
            flagged = mediafile.exif_gps(data, ct)
            self.assertLess(time.time() - t0, 1.0)
            self.assertIsNone(out)
            self.assertTrue(flagged)

    def test_an_inflate_bomb_is_bounded_and_held(self):
        bomb = zlib.compress(b" " * (48 * 1024 * 1024), 9)
        for kind, body in ((b"zTXt", b"Comment\x00\x00" + bomb), (b"iTXt", b"XML:com.adobe.xmp\x00\x01\x00\x00\x00" + bomb)):
            base = LS.png(tiff=tiff_main())
            iend = base.rindex(b"IEND") - 4
            data = base[:iend] + LS.chunk(kind, body) + base[iend:]
            tracemalloc.start()
            t0 = time.time()
            flagged = mediafile.exif_gps(data, PNG)
            out, _why = mediafile.strip_copy(data, PNG)
            _now, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            self.assertLess(peak, 24 * 1024 * 1024, "the output of the inflate is capped")
            self.assertLess(time.time() - t0, 2.0)
            self.assertTrue(flagged)
            self.assertIsNone(out)


def gps_ifd(order="<"):
    return LS.gps_entries(order)


def exif_subifd_tiff(order="<", gps_entries=None):
    """A TIFF whose only GPS pointer is inside the Exif sub-IFD (IFD0 has none)."""
    ifds = [("ifd0", [LS.asc(order, 0x010F, LS.MAKE), LS.ref(0x8769, "ifd", "exif")], None),
            ("exif", [(0x9003, 2, len(LS.DATE) + 1, LS.DATE + b"\x00"), LS.ref(0x8825, "ifd", "gps")], None),
            ("gps", gps_entries or gps_ifd(order), None)]
    return LS.assemble(order, ifds, {})


class TheDetector(unittest.TestCase):
    """A position in a place the old detector did not read is found now (so it is held with the setting off), and then stripped or held."""

    def found(self, data, ct):
        self.assertTrue(mediafile.exif_gps(data, ct))
        return mediafile.strip_copy(data, ct)

    def test_gps_only_in_the_exif_sub_ifd(self):
        data = LS.jpeg(exif_subifd_tiff())
        self.assertFalse(mediafile.tiff_has_gps(exif_subifd_tiff()), "the older IFD0 reading misses it")
        out, why = self.found(data, JPEG)
        self.assertIsNotNone(out, why)
        self.assertFalse(mediafile.exif_gps(out, JPEG))

    def test_gps_only_in_deflated_png_xmp(self):
        out, why = self.found(LS.png(xmp=LS.xmp_packet(), compress_xmp=True), PNG)
        self.assertIsNotNone(out, why)
        self.assertFalse(mediafile.exif_gps(out, PNG))

    def test_gps_only_in_a_hex_raw_profile_is_found_and_held(self):
        hexed = b"\nexif\n%8d\n" % (6 + len(raw_tiff())) + (b"Exif\x00\x00" + raw_tiff()).hex().encode()
        data = LS.png(text=b"Raw profile type exif\x00" + hexed)
        out, _why = self.found(data, PNG)
        self.assertIsNone(out)
        data = LS.png()
        iend = data.rindex(b"IEND") - 4
        data = data[:iend] + LS.chunk(b"zTXt", b"Raw profile type exif\x00\x00" + zlib.compress(hexed)) + data[iend:]
        out, _why = self.found(data, PNG)
        self.assertIsNone(out)

    def test_gps_only_behind_an_exif_nul_ff_header(self):
        data = LS.jpeg(None, extra_segments=LS.segment(0xE1, b"Exif\x00\xff" + raw_tiff()))
        out, _why = self.found(data, JPEG)
        self.assertIsNone(out)

    def test_gps_only_in_utf16_xmp(self):
        data = LS.jpeg(None, extra_segments=LS.segment(0xE1, b"http://ns.adobe.com/xap/1.0/\x00" + utf16(LS.xmp_packet())))
        out, _why = self.found(data, JPEG)
        self.assertIsNone(out)

    def test_dji_gps_names_without_any_exif_gps(self):
        xmp = LS.xmp_packet(gps=False).replace(b' exif:DateTimeOriginal', b' drone-dji:GpsLatitude="37.5712" drone-dji:GpsLongtitude="-122.0809" exif:DateTimeOriginal', 1)
        out, why = self.found(LS.jpeg(None, xmp), JPEG)
        self.assertIsNotNone(out, why)
        self.assertNotIn(b"Gps", out)

    def test_a_gps_ifd_with_an_altitude_and_an_area_name_but_no_latitude(self):
        entries = [e for e in gps_ifd() if e[0] not in (0x0002, 0x0004)]
        out, why = self.found(LS.jpeg(exif_subifd_tiff(gps_entries=entries)), JPEG)
        self.assertIsNotNone(out, why)

    def test_a_gps_ifd_that_holds_only_a_version_and_zero_positions_is_not_a_position(self):
        zero = [(0x0000, 1, 4, b"\x02\x03\x00\x00"), (0x0001, 2, 2, b"N\x00"), (0x0002, 5, 3, LS.rational_bytes("<", ((0, 1), (0, 1), (0, 1))))]
        self.assertFalse(mediafile.exif_gps(LS.jpeg(exif_subifd_tiff(gps_entries=zero)), JPEG))

    def test_files_without_a_position_are_not_found(self):
        self.assertFalse(mediafile.exif_gps(LS.jpeg(LS.build_tiff(gps=False), LS.xmp_packet(gps=False)), JPEG))
        self.assertFalse(mediafile.exif_gps(LS.png(tiff=LS.build_tiff(gps=False), xmp=LS.xmp_packet(gps=False), compress_xmp=True), PNG))
        self.assertFalse(mediafile.exif_gps(LS.jpeg(None, extra_segments=LS.segment(0xE2, b"ICC_PROFILE\x00\x01\x01" + bytes(range(256)) * 8)), JPEG))

    def test_the_download_check_finds_them_too(self):
        data = LS.jpeg(exif_subifd_tiff())
        self.assertEqual(mediafile.hold_for_bytes(data), mediafile.GPS_RULE)


if __name__ == "__main__":
    unittest.main()
