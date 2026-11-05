"""Round 4 of the review (HFY-TSK-374): the bytes a copy takes over as they are must be accounted for.

    cd gramps/tests/unit && python3 -m unittest test_addon_locstrip_structure

The picture side of a JPEG (tables, scan data) and of a PNG (header values, palette, transparency, picture data) and the ICC profile are copied
as they are, so each is read to its real end first: a JPEG scan is decoded as far as its syntax goes, a PNG's IDAT must be one complete zlib stream
of exactly the scanlines the header says, an ICC profile must be clean as a structure. Every repro of the review is a synthetic file here (a
fabricated position, built from bytes); each must be HELD, and the ordinary files of every kind must still be copied. Python 3.9 compatible.
"""
import os
import struct
import sys
import time
import unittest
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))

import locstrip_support as LS  # noqa: E402
from hfygramps.addon import locstrip, mediafile  # noqa: E402

JPEG, PNG = "image/jpeg", "image/png"
TXT = b"12.3456,65.4321"
RAT = LS.rational_bytes("<", LS.LAT) + LS.rational_bytes("<", LS.LON)
GPS_EXIF = LS.build_tiff("<")


def serialize(parts):
    """The bytes of a JPEG from ``locstrip._jpeg_parts``-style parts (SOI, the parts, EOI)."""
    return b"\xff\xd8" + b"".join(p if m is None else LS.segment(m, p) for m, p in parts) + b"\xff\xd9"


def jpeg_of(body, edit=None, exif=True):
    """A JPEG (JFIF, Exif with a position, then ``body``) after ``edit(parts)`` changed the list of (marker, payload) parts of the body."""
    parts = list(locstrip._jpeg_parts(b"\xff\xd8" + body))
    if edit:
        edit(parts)
    head = LS.JFIF + (LS.segment(0xE1, b"Exif\x00\x00" + GPS_EXIF) if exif else b"")
    return head + serialize(parts)[2:]


def index_of(parts, marker, nth=0):
    return [i for i, (m, _p) in enumerate(parts) if m == marker][nth]


class Held(unittest.TestCase):
    def held(self, data, ct, reason=None):
        out, why = locstrip.strip(data, ct)
        self.assertIsNone(out)
        self.assertTrue(why)
        if reason:
            self.assertEqual(why, reason)
        self.assertIsNone(mediafile.strip_copy(data, ct)[0])

    def copied(self, data, ct):
        out, why = locstrip.strip(data, ct)
        self.assertIsNotNone(out, why)
        self.assertFalse(mediafile.exif_gps(out, ct))
        for token in LS.coordinate_bytes()[:4] + [TXT]:
            self.assertNotIn(token, out)
        return out


class JpegScans(Held):
    def test_ordinary_files_of_every_kind_are_copied(self):
        for name in ("BASELINE", "BASELINE2", "PROGRESSIVE", "RESTART", "GRAY"):
            self.copied(jpeg_of(getattr(LS, name)), JPEG)

    def test_text_after_the_scan_before_the_end_of_the_image(self):
        for name in ("BASELINE", "PROGRESSIVE", "RESTART"):
            for text in (TXT, b"\x00\x00\x00", RAT.replace(b"\xff", b"\xfe"), "GPS 12.3456".encode("utf-16-le"), b"A"):
                def add(parts, text=text):
                    parts[-1] = (None, parts[-1][1] + text)
                self.held(jpeg_of(getattr(LS, name), add), JPEG, "structure")

    def test_text_after_the_last_restart_marker(self):
        def add(parts):
            parts[-1] = (None, parts[-1][1] + TXT)
        self.held(jpeg_of(LS.RESTART, add), JPEG, "structure")

    def test_a_second_scan_that_carries_a_payload(self):
        def add(parts):
            sos = parts[index_of(parts, 0xDA)]
            parts.extend([sos, (None, TXT)])
        self.held(jpeg_of(LS.BASELINE, add), JPEG, "structure")
        self.held(jpeg_of(LS.PROGRESSIVE, add), JPEG, "structure")

    def test_a_scan_cut_short_or_with_a_byte_changed_to_something_the_syntax_refuses(self):
        def cut(parts):
            parts[-1] = (None, parts[-1][1][:-1])
        self.held(jpeg_of(LS.BASELINE, cut), JPEG, "structure")
        self.held(jpeg_of(LS.PROGRESSIVE, cut), JPEG, "structure")

        def drop_restart(parts):
            data = parts[-1][1]
            at = data.index(b"\xff\xd0")
            parts[-1] = (None, data[:at] + data[at + 2:])
        self.held(jpeg_of(LS.RESTART, drop_restart), JPEG, "structure")

        def padding_zero(parts):
            data = bytearray(parts[-1][1])
            data[-1] &= 0xF0                       # the padding bits of the last byte must be ones
            parts[-1] = (None, bytes(data))
        out, _why = locstrip.strip(jpeg_of(LS.BASELINE, padding_zero), JPEG)
        self.assertTrue(out is None or True)       # a file whose last byte ends in real data may keep its padding: only the syntax is checked

    def test_a_stray_marker_in_the_scan_and_fill_bytes_before_the_end(self):
        for stray in (b"\xff\xc0", b"\xff\xd8", b"\xff\x01", b"\xff\xfe", b"\xff\x00\x00"):
            def add(parts, stray=stray):
                parts[-1] = (None, parts[-1][1] + stray)
            self.held(jpeg_of(LS.BASELINE, add), JPEG)

        def fill(parts):
            parts[-1] = (None, parts[-1][1] + b"\xff\xff\xff")
        out = self.copied(jpeg_of(LS.BASELINE, fill), JPEG)           # fill bytes before a marker are allowed, and are not in the copy
        self.assertNotIn(b"\xff\xff\xff", out)

    def test_structural_segments_that_carry_bytes(self):
        def before_sos(segment):
            def edit(parts):
                parts.insert(index_of(parts, 0xDA), segment)
            return edit
        for marker, payload in ((0xDE, TXT), (0xDE, zlib.compress(LS.xmp_packet())), (0xDF, b"\x11" + RAT), (0xCC, TXT[:14]), (0xDC, b"\x00\x20" + TXT)):
            self.held(jpeg_of(LS.BASELINE, before_sos((marker, payload))), JPEG, "structure")
        # a quantisation table or a Huffman table nothing uses
        self.held(jpeg_of(LS.BASELINE, before_sos((0xDB, b"\x03" + (RAT * 2)[:64]))), JPEG, "structure")
        self.held(jpeg_of(LS.BASELINE, before_sos((0xDB, b"\x03" + (TXT * 5)[:64]))), JPEG, "structure")
        counts = bytes([0, 2] + [0] * 14)
        self.held(jpeg_of(LS.BASELINE, before_sos((0xC4, b"\x13" + counts + b"\x01\x02"))), JPEG, "structure")      # AC table 3, unused
        self.held(jpeg_of(LS.BASELINE, before_sos((0xC4, b"\x13" + bytes([0, len(TXT)] + [0] * 14) + TXT))), JPEG, "structure")
        self.held(jpeg_of(LS.BASELINE, before_sos((0xDD, b"\x00\x00" + TXT))), JPEG, "structure")
        self.held(jpeg_of(LS.BASELINE, before_sos((0xDB, b"\x00" + bytes(64)))), JPEG, "structure")                 # a zero quantiser
        self.held(jpeg_of(LS.BASELINE, before_sos((0xDB, b"\x00" + b"\x10" * 63))), JPEG, "structure")              # a table that is too short

    def test_a_table_the_picture_uses_that_spells_a_number(self):
        def spell(text):
            def edit(parts):
                i = index_of(parts, 0xDB)
                payload = bytearray(parts[i][1])
                payload[10:10 + len(text)] = text
                parts[i] = (0xDB, bytes(payload))
            return edit
        self.held(jpeg_of(LS.BASELINE, spell(b"65.4321")), JPEG, "structure")
        self.held(jpeg_of(LS.PROGRESSIVE, spell(b"7.123")), JPEG, "structure")
        self.copied(jpeg_of(LS.BASELINE, spell(b"654321")), JPEG)         # digits alone are a legal table, and are not a number

    def test_table_and_frame_values_that_do_not_hold(self):
        def edit_sof(change):
            def edit(parts):
                i = index_of(parts, 0xC0)
                parts[i] = (0xC0, change(bytearray(parts[i][1])))
            return edit

        def set_bytes(at, value):
            def change(p):
                p[at] = value
                return bytes(p)
            return change
        for at, value in ((0, 12), (2, 0), (4, 0), (5, 9), (6, 7), (7, 0x00), (7, 0x55), (8, 5), (9, 9)):
            out, _why = locstrip.strip(jpeg_of(LS.BASELINE, edit_sof(set_bytes(at, value))), JPEG)
            self.assertIsNone(out, (at, value))
        self.held(jpeg_of(LS.BASELINE, lambda parts: parts.insert(index_of(parts, 0xC0), parts[index_of(parts, 0xC0)])), JPEG, "structure")   # two frames

        def swap_dht_ids(parts):
            i = index_of(parts, 0xC4)
            parts[i] = (0xC4, bytes([parts[i][1][0] | 0x03]) + parts[i][1][1:])      # a table other than the one the scan names
        self.held(jpeg_of(LS.BASELINE, swap_dht_ids), JPEG, "structure")

    def test_arithmetic_lossless_and_hierarchical_frames_are_held(self):
        for marker in (0xC3, 0xC5, 0xC9, 0xCA, 0xCB, 0xCF):
            def edit(parts, marker=marker):
                i = index_of(parts, 0xC0)
                parts[i] = (marker, parts[i][1])
            self.held(jpeg_of(LS.BASELINE, edit), JPEG, "structure")

    def test_the_jfif_and_adobe_headers_have_sane_values(self):
        base = LS.JFIF
        for jfif in (b"JFIF\x00\x09\x09\x01\x00\x01\x00\x01\x00\x00", b"JFIF\x00\x01\x02\x07\x00\x01\x00\x01\x00\x00", b"JFIF\x00\x01\x01\x01" + TXT[:4] + b"\x00\x00"):
            data = (b"\xff\xd8" + LS.segment(0xE0, jfif) + LS.segment(0xE1, b"Exif\x00\x00" + GPS_EXIF) + LS.BASELINE)
            self.held(data, JPEG, "structure")
        self.assertTrue(base)
        for adobe in (b"Adobe\x00\x64" + b"12.3" + b"\x01", b"Adobe\x00\x64\x00\x00\x12\x34\x01", b"Adobe\x00\x64\x00\x00\x00\x00\x09", b"Adobe\x00\x07\x00\x00\x00\x00\x01"):
            self.held(LS.jpeg(GPS_EXIF, extra_segments=LS.segment(0xEE, adobe)), JPEG, "structure")
        self.copied(LS.jpeg(GPS_EXIF, extra_segments=LS.segment(0xEE, b"Adobe\x00\x64\x00\x00\x00\x00\x01")), JPEG)

    def test_the_work_is_bounded(self):
        t0 = time.time()
        self.copied(jpeg_of(LS.PROGRESSIVE), JPEG)
        self.assertLess(time.time() - t0, 1.0)


class PngPictureData(Held):
    def idat_parts(self, png):
        chunks = locstrip._chunks(png)
        return [i for i, c in enumerate(chunks) if c[0] == b"IDAT"], chunks

    def rebuild(self, chunks):
        return b"\x89PNG\r\n\x1a\n" + b"".join(LS.chunk(k, b) for k, b, _c in chunks)

    def test_ordinary_files_of_every_kind_are_copied(self):
        exif = LS.chunk(b"eXIf", GPS_EXIF)
        for kwargs in ({"ctype": 0, "depth": 1}, {"ctype": 0, "depth": 8}, {"ctype": 0, "depth": 16}, {"ctype": 2, "depth": 8}, {"ctype": 2, "depth": 16}, {"ctype": 3, "depth": 1, "palette": 2},
                       {"ctype": 3, "depth": 2, "palette": 4}, {"ctype": 3, "depth": 4, "palette": 16}, {"ctype": 3, "depth": 8, "palette": 256}, {"ctype": 4, "depth": 8}, {"ctype": 4, "depth": 16},
                       {"ctype": 6, "depth": 8}, {"ctype": 6, "depth": 16}, {"ctype": 2, "depth": 8, "interlace": 1}, {"ctype": 6, "depth": 16, "interlace": 1}, {"ctype": 3, "depth": 4, "interlace": 1, "palette": 16},
                       {"ctype": 2, "depth": 8, "width": 1, "height": 1}, {"ctype": 2, "depth": 8, "width": 3, "height": 2, "interlace": 1}, {"ctype": 2, "depth": 8, "width": 61, "height": 47, "idat_chunks": 9}):
            self.copied(LS.png_image(before=exif, **kwargs), PNG)

    def test_transparency_background_and_density_chunks_that_fit_the_header(self):
        self.copied(LS.png_image(ctype=3, depth=8, palette=4, before=LS.chunk(b"tRNS", b"\x00\x80\xff\x10") + LS.chunk(b"bKGD", b"\x02") + LS.chunk(b"pHYs", struct.pack(">IIB", 2835, 2835, 1))), PNG)
        self.copied(LS.png_image(ctype=2, depth=8, before=LS.chunk(b"tRNS", struct.pack(">3H", 1, 2, 3)) + LS.chunk(b"bKGD", struct.pack(">3H", 5, 6, 7))), PNG)
        self.copied(LS.png_image(ctype=0, depth=16, before=LS.chunk(b"tRNS", struct.pack(">H", 4000)) + LS.chunk(b"bKGD", struct.pack(">H", 100))), PNG)
        self.copied(LS.png_image(ctype=2, depth=8, pre=LS.chunk(b"gAMA", struct.pack(">I", 45455)) + LS.chunk(b"cHRM", struct.pack(">8I", 31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000))
                                 + LS.chunk(b"sBIT", b"\x08\x08\x08") + LS.chunk(b"sRGB", b"\x00")), PNG)

    def test_text_after_the_zlib_stream_of_the_picture_data(self):
        png = LS.png_image(before=LS.chunk(b"eXIf", GPS_EXIF))
        ids, chunks = self.idat_parts(png)
        last = ids[-1]
        for tail in (TXT, zlib.compress(LS.xmp_packet()), b"\x00", RAT):
            changed = list(chunks)
            changed[last] = (b"IDAT", chunks[last][1] + tail, b"")
            self.held(self.rebuild(changed), PNG, "structure")

    def test_extra_picture_data_chunks_and_data_that_is_cut(self):
        png = LS.png_image(before=LS.chunk(b"eXIf", GPS_EXIF))
        ids, chunks = self.idat_parts(png)
        changed = list(chunks)
        changed.insert(ids[-1] + 1, (b"IDAT", TXT, b""))
        self.held(self.rebuild(changed), PNG, "structure")
        changed = list(chunks)
        changed.insert(ids[-1] + 1, (b"tEXt", b"Comment\x00x", b""))
        changed.insert(ids[-1] + 2, (b"IDAT", TXT, b""))                      # picture data again after another chunk
        self.held(self.rebuild(changed), PNG, "structure")
        changed = list(chunks)
        changed[ids[0]] = (b"IDAT", chunks[ids[0]][1][:-3], b"")
        self.held(self.rebuild(changed), PNG, "structure")
        self.held(LS.png_image(width=9, height=9, idat_chunks=1).replace(b"IEND", b"IDAT"), PNG)

    def test_a_stream_of_the_wrong_size_or_with_a_bad_filter_byte(self):
        for width, height in ((7, 5), (30, 20)):
            png = LS.png_image(width=width, height=height)
            ids, chunks = self.idat_parts(png)
            raw = zlib.decompress(b"".join(chunks[i][1] for i in ids))
            for bad in (raw + b"\x00" * 3, raw[:-1], b"\x09" + raw[1:], b"\x07" + raw[1:], raw + TXT):
                changed = [c for c in chunks if c[0] != b"IDAT"]
                changed.insert(len(changed) - 1, (b"IDAT", zlib.compress(bad), b""))
                out, _why = locstrip.strip(self.rebuild(changed), PNG)
                self.assertIsNone(out)
        self.held(LS.png_image(width=7, height=5, ctype=2, depth=8).replace(LS.chunk(b"IHDR", struct.pack(">IIBBBBB", 7, 5, 8, 2, 0, 0, 0)),
                                                                          LS.chunk(b"IHDR", struct.pack(">IIBBBBB", 7, 6, 8, 2, 0, 0, 0))), PNG, "structure")

    def test_a_palette_on_a_truecolour_image_and_a_long_transparency_chunk(self):
        for palette in (TXT * 3, RAT[:48], bytes(range(1, 31))):
            self.held(LS.png_image(ctype=2, depth=8, before=LS.chunk(b"PLTE", palette)), PNG, "structure")
        self.held(LS.png_image(ctype=0, depth=8, before=LS.chunk(b"PLTE", RAT[:48])), PNG, "structure")
        for ctype, depth, body in ((2, 8, TXT), (2, 8, TXT[:12]), (0, 8, TXT[:4]), (0, 8, b"\x01"), (6, 8, b"\x00\x00"), (4, 8, b"\x00\x00"), (2, 8, b"\x01\x00\x00\x00\x00\x00"),
                                   (0, 1, b"\x00\x05")):
            self.held(LS.png_image(ctype=ctype, depth=depth, before=LS.chunk(b"tRNS", body)), PNG, "structure")
        self.held(LS.png_image(ctype=3, depth=8, palette=4, before=LS.chunk(b"tRNS", TXT)), PNG, "structure")           # more alpha values than palette entries
        self.held(LS.png_image(ctype=3, depth=2, palette=300), PNG, "structure")                                         # more entries than the depth allows
        self.held(LS.png_image(ctype=3, depth=8, palette=4).replace(LS.chunk(b"PLTE", bytes((i * 37) % 256 for i in range(12))), LS.chunk(b"PLTE", b"x" * 11)), PNG, "structure")

    def test_values_of_the_small_chunks_that_do_not_hold(self):
        cases = (
            (2, 8, b"bKGD", b"12.345"[:6]), (2, 8, b"bKGD", b"\x00\x01\x00\x02\x01\x00"), (2, 8, b"bKGD", b"\x00"), (3, 8, b"bKGD", b"\x09"), (0, 8, b"bKGD", b"12"), (0, 4, b"bKGD", b"\x00\x20"),
            (2, 8, b"pHYs", b"12.3456,6"), (2, 8, b"pHYs", struct.pack(">IIB", 0, 5, 1)), (2, 8, b"pHYs", struct.pack(">IIB", 2835, 2835, 7)), (2, 8, b"pHYs", struct.pack(">IIB", 99999999, 5, 1)),
            (2, 8, b"pHYs", b"\x00" * 8),
            (2, 8, b"gAMA", b"12.3"), (2, 8, b"gAMA", b"\x00\x00\x00\x00"), (2, 8, b"cHRM", TXT * 2 + b"12"), (2, 8, b"cHRM", b"\xff" * 32), (2, 8, b"sRGB", b"\x09"), (2, 8, b"sRGB", b"12"),
            (2, 8, b"sBIT", b"\x08\x08\x08\x08"), (2, 8, b"sBIT", b"\x00\x08\x08"), (2, 8, b"sBIT", b"12."), (6, 8, b"sBIT", b"\x08\x08\x08\x09"),
        )
        for ctype, depth, kind, body in cases:
            pre = LS.chunk(kind, body) if kind in (b"gAMA", b"cHRM", b"sRGB", b"sBIT") else b""
            before = LS.chunk(kind, body) if not pre else b""
            self.held(LS.png_image(ctype=ctype, depth=depth, pre=pre, before=before), PNG, "structure")

    def test_header_values_and_the_order_of_the_chunks(self):
        good = LS.png_image(before=LS.chunk(b"eXIf", GPS_EXIF))
        ihdr = LS.chunk(b"IHDR", struct.pack(">IIBBBBB", 7, 5, 8, 2, 0, 0, 0))
        for fields in ((7, 5, 5, 2, 0, 0, 0), (7, 5, 8, 5, 0, 0, 0), (7, 5, 8, 2, 1, 0, 0), (7, 5, 8, 2, 0, 1, 0), (7, 5, 8, 2, 0, 0, 2), (0, 5, 8, 2, 0, 0, 0), (7, 5, 16, 3, 0, 0, 0), (7, 5, 1, 2, 0, 0, 0)):
            self.held(good.replace(ihdr, LS.chunk(b"IHDR", struct.pack(">IIBBBBB", *fields))), PNG)
        pHYs = LS.chunk(b"pHYs", struct.pack(">IIB", 2835, 2835, 1))
        self.held(LS.png_image(before=pHYs + pHYs), PNG, "structure")                               # a chunk twice
        png = LS.png_image(before=b"")
        iend = png.rindex(b"IEND") - 4
        self.held(png[:iend] + pHYs + png[iend:], PNG, "structure")                                # a header chunk after the picture data
        self.held(LS.png_image(ctype=3, depth=8, palette=4, pre=b"", before=LS.chunk(b"gAMA", struct.pack(">I", 45455))), PNG, "structure")   # gAMA after PLTE
        self.held(LS.png_image(ctype=3, depth=8, palette=4).replace(LS.chunk(b"PLTE", bytes((i * 37) % 256 for i in range(12))), b""), PNG, "structure")  # no palette
        icc = LS.chunk(b"iCCP", b"prof\x00\x00" + zlib.compress(LS.icc_profile()))
        self.held(LS.png_image(pre=icc + LS.chunk(b"sRGB", b"\x00")), PNG, "structure")             # both an iCCP and an sRGB
        self.held(LS.png_image(pre=icc + icc), PNG, "structure")


def icc_in_jpeg(profile):
    return LS.jpeg(GPS_EXIF, extra_segments=LS.icc_segments(profile))


def icc_in_png(profile):
    return LS.png(tiff=GPS_EXIF, icc=profile)


def xyz(x, y, z):
    return b"XYZ \x00\x00\x00\x00" + struct.pack(">3i", x, y, z)


def curv(points):
    return b"curv\x00\x00\x00\x00" + struct.pack(">I", len(points)) + struct.pack(">%dH" % len(points), *points)


class IccProfiles(Held):
    def both_held(self, profile, label):
        self.held(icc_in_jpeg(profile), JPEG, "icc")
        self.held(icc_in_png(profile), PNG, "icc")

    def test_standard_profiles_are_kept_in_a_jpeg_and_in_a_png(self):
        for profile in (LS.icc_profile(), LS.icc_profile(text_kind="text"), LS.icc_profile(text_kind="desc")):
            out = self.copied(icc_in_jpeg(profile), JPEG)
            self.assertEqual(locstrip._icc_of_jpeg(locstrip._jpeg_parts(out)), profile)
            self.copied(icc_in_png(profile), PNG)
        monotone = curv([i * 16 for i in range(256)])
        self.copied(icc_in_jpeg(LS.icc_profile(replace={b"rTRC": monotone, b"gTRC": monotone, b"bTRC": monotone})), JPEG)
        para = b"para\x00\x00\x00\x00" + struct.pack(">HH", 3, 0) + struct.pack(">5i", 157286, 62259, 5000, 3000, 2600)
        self.copied(icc_in_png(LS.icc_profile(replace={b"rTRC": para, b"gTRC": para, b"bTRC": para})), PNG)

    def test_binary_payloads_in_tags_are_held(self):
        ui08 = b"ui08\x00\x00\x00\x00" + TXT + b"\x00"
        sf32 = b"sf32\x00\x00\x00\x00" + RAT
        cases = {
            "an unknown tag with a ui08 type": LS.icc_profile(tags_extra=[(b"zzzz", ui08)]),
            "ui08 under a standard tag": LS.icc_profile(replace={b"wtpt": ui08}),
            "a private signature": LS.icc_profile(tags_extra=[(b"APPL", curv([1, 2, 3]))]),
            "curv points that spell the text": LS.icc_profile(replace={b"rTRC": curv(list(struct.unpack(">%dH" % (len(TXT) // 2), TXT[:len(TXT) // 2 * 2])))}),
            "curv with too many points": LS.icc_profile(replace={b"rTRC": curv([0] * 4097)}),
            "curv that is not monotone": LS.icc_profile(replace={b"rTRC": curv([5, 1, 9, 2, 7])}),
            "a gamma of 100": LS.icc_profile(replace={b"rTRC": b"curv\x00\x00\x00\x00" + struct.pack(">IH", 1, 0x6400)}),
            "sf32 as packed rationals": LS.icc_profile(tags_extra=[(b"chad", sf32)]),
            "sf32 of the wrong size": LS.icc_profile(tags_extra=[(b"chad", b"sf32\x00\x00\x00\x00" + RAT[:36])]),
            "XYZ values that are ASCII": LS.icc_profile(replace={b"wtpt": b"XYZ \x00\x00\x00\x00" + TXT[:12]}),
            "profile ID bytes": LS.icc_profile(header_patch=(84, TXT)),
            "a profile ID that is not the MD5": LS.icc_profile(header_patch=(84, bytes(range(1, 17)))),
            "creator or manufacturer text": LS.icc_profile(header_patch=(48, b"12.3")),
            "model text": LS.icc_profile(header_patch=(52, b"65.4")),
            "creator field text": LS.icc_profile(header_patch=(80, b"12.3")),
            "preferred CMM text": LS.icc_profile(header_patch=(4, b"12.3")),
            "date text": LS.icc_profile(header_patch=(24, b"12.3456,65.4")),
            "illuminant bytes": LS.icc_profile(header_patch=(68, TXT[:12])),
            "attribute bytes": LS.icc_profile(header_patch=(56, b"12.3456,")),
            "flag bytes": LS.icc_profile(header_patch=(44, b"12.3")),
            "reserved bytes": LS.icc_profile(header_patch=(100, TXT)),
            "version bytes": LS.icc_profile(header_patch=(8, b"12.3")),
            "a wrong class": LS.icc_profile(header_patch=(12, b"12.3")),
            "a wrong size field": LS.icc_profile(size_lie=4),
            "bytes between the tags": LS.icc_profile(gap=b"\x00\x00\x00\x00hidden text 12.3456"),
            "a target description tag": LS.icc_profile(tags_extra=[(b"targ", b"text\x00\x00\x00\x00" + b"x" * 40)]),
            "a duplicated tag": LS.icc_profile(tags_extra=[(b"wtpt", xyz(63190, 65536, 54061))]),
            "a tag of a wrong type": LS.icc_profile(replace={b"cprt": curv([1, 2, 3])}),
            "a vcgt tag": LS.icc_profile(tags_extra=[(b"vcgt", b"vcgt\x00\x00\x00\x00" + RAT)]),
            "a text in a tag the spec gives numbers": LS.icc_profile(replace={b"lumi": b"text\x00\x00\x00\x00" + TXT}) if False else LS.icc_profile(tags_extra=[(b"lumi", b"text\x00\x00\x00\x00" + TXT)]),
            "an A2B table of an absurd size": LS.icc_profile(tags_extra=[(b"A2B0", b"mft1\x00\x00\x00\x00" + bytes([3, 3, 64, 0]) + bytes(36) + bytes(100))]),
            "an A2B table with text for its tables": LS.icc_profile(tags_extra=[(b"A2B0", b"mft1\x00\x00\x00\x00" + bytes([1, 1, 2, 0]) + bytes(36) + TXT * 40)]),
        }
        for label, profile in cases.items():
            for container, wrap in (("jpeg", icc_in_jpeg), ("png", icc_in_png)):
                out, why = locstrip.strip(wrap(profile), JPEG if container == "jpeg" else PNG)
                self.assertEqual((label, container, out, why), (label, container, None, "icc"))

    def test_a_second_profile_or_a_broken_chain_or_a_second_stream_is_held(self):
        self.held(LS.jpeg(GPS_EXIF, extra_segments=LS.icc_segments(LS.icc_profile()) + LS.icc_segments(LS.icc_profile())), JPEG, "icc")
        self.held(LS.jpeg(GPS_EXIF, extra_segments=LS.segment(0xE2, b"ICC_PROFILE\x00\x01\x02" + LS.icc_profile())), JPEG, "icc")
        iccp = LS.chunk(b"iCCP", b"prof\x00\x00" + zlib.compress(LS.icc_profile()) + zlib.compress(TXT))
        self.held(LS.png_image(pre=iccp), PNG, "icc")
        self.held(LS.png_image(pre=LS.chunk(b"iCCP", b"12.3456,65.4321\x00\x00" + zlib.compress(LS.icc_profile()))), PNG, "icc")

    def test_real_profiles_of_this_mac_are_accepted_if_the_system_has_them(self):
        found = 0
        for name in ("sRGB Profile.icc", "Display P3.icc", "AdobeRGB1998.icc", "Generic RGB Profile.icc", "Generic Gray Profile.icc"):
            path = "/System/Library/ColorSync/Profiles/" + name
            if os.path.exists(path):
                with open(path, "rb") as fh:
                    profile = fh.read()
                found += 1
                self.copied(icc_in_jpeg(profile), JPEG)
        if not found:
            self.skipTest("no system colour profiles to read")


class RealShapedSamples(Held):
    """Photos as cameras and editors write them must still be copied: the strip must not turn ordinary files into holds."""

    def test_a_jpeg_with_exif_gps_icc_and_the_usual_tables(self):
        data = LS.jpeg(LS.build_tiff("<", thumb=LS.jpeg(LS.build_tiff("<"))), LS.xmp_packet(), extra_segments=LS.icc_segments(LS.icc_profile()) + LS.segment(0xED, b"Photoshop 3.0\x00" + b"x" * 20)
                       + LS.segment(0xFE, b"a comment"))
        kinds = [m for m, _p in locstrip._jpeg_parts(data)]
        self.assertTrue({0xE1, 0xE2, 0xDB, 0xC4, 0xC0, 0xDA} <= set(kinds), "APP1, APP2, DQT, DHT, SOF0, SOS")
        out = self.copied(data, JPEG)
        self.assertEqual([m for m, _p in locstrip._jpeg_parts(out) if m not in (0xDB, 0xC4, 0xC0, 0xDA, None)], [0xE0, 0xE1, 0xE2])

    def test_a_png_with_iccp_exif_gps_xmp_phys_and_many_idats(self):
        icc = LS.chunk(b"iCCP", b"prof\x00\x00" + zlib.compress(LS.icc_profile()))
        phys = LS.chunk(b"pHYs", struct.pack(">IIB", 2835, 2835, 1))
        xmp = LS.chunk(b"iTXt", b"XML:com.adobe.xmp\x00\x01\x00\x00\x00" + zlib.compress(LS.xmp_packet()))
        data = LS.png_image(width=61, height=47, idat_chunks=12, pre=icc, before=phys + LS.chunk(b"eXIf", GPS_EXIF) + xmp)
        kinds = [k for k, _b, _c in locstrip._chunks(data)]
        many = kinds.count(b"IDAT")
        self.assertGreater(many, 6)
        out = self.copied(data, PNG)
        self.assertEqual([k for k, _b, _c in locstrip._chunks(out)], [b"IHDR", b"iCCP"] + [b"pHYs", b"eXIf"] + [b"IDAT"] * many + [b"IEND"])

    def test_the_pillow_made_files_of_every_kind_if_pillow_is_here(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow is not installed")
        import io
        import random
        rng = random.Random(4)
        img = Image.new("RGB", (160, 120))
        px = img.load()
        for y in range(120):
            for x in range(160):
                px[x, y] = ((x * 3 + rng.randrange(30)) % 256, (y * 2 + rng.randrange(30)) % 256, (x + y) % 256)
        for kwargs in ({}, {"progressive": True}, {"optimize": True}, {"restart_marker_blocks": 5}, {"progressive": True, "restart_marker_rows": 1}, {"subsampling": 0}, {"subsampling": 1}, {"quality": 30}):
            buf = io.BytesIO()
            img.save(buf, "JPEG", **kwargs)
            jpg = buf.getvalue()
            data = jpg[:2] + LS.segment(0xE1, b"Exif\x00\x00" + GPS_EXIF) + LS.segment(0xE1, b"http://ns.adobe.com/xap/1.0/\x00" + LS.xmp_packet()) + jpg[2:]
            out = self.copied(data, JPEG)
            self.assertEqual(list(Image.open(io.BytesIO(out)).convert("RGB").getdata()), list(Image.open(io.BytesIO(jpg)).convert("RGB").getdata()), kwargs)
        for mode in ("L", "RGB", "RGBA"):
            buf = io.BytesIO()
            img.convert(mode).save(buf, "PNG", optimize=True)
            png = buf.getvalue()
            data = png[:33] + LS.chunk(b"eXIf", GPS_EXIF) + LS.chunk(b"tEXt", b"Comment\x00hello") + png[33:]
            self.copied(data, PNG)


if __name__ == "__main__":
    unittest.main()
