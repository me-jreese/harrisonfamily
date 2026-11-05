"""Round 5 of the review (HFY-TSK-374): the words of an ICC profile are never kept, they are written again.

    cd gramps/tests/unit && python3 -m unittest test_addon_locstrip_icc_text

A kept profile (a JPEG's APP2, a PNG's iCCP) used to have its text tags checked for a position; a pattern cannot tell digits that are far apart,
spaced numbers or numbers in words from a name. So every text-bearing tag (desc, cprt, dmnd, dmdd, vued, dscm; textType, textDescriptionType and
multiLocalizedUnicode) is written again with a fixed neutral string in its own type, the colour tags are carried over byte for byte, and the
header's free-text fields and the profile ID are zero. Every position here is fabricated. Also here: the small covert channels of the picture side
that round 5 closed (unused bits at the end of rows of a 1, 2 or 4 bit PNG; a quantisation table that spells digits without a dot).
Python 3.9 compatible.
"""
import glob
import os
import random
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(os.path.dirname(HERE)))

import locstrip_support as LS  # noqa: E402
from hfygramps.addon import locstrip  # noqa: E402
from test_addon_locstrip_structure import GPS_EXIF, Held, JPEG, PNG, icc_in_jpeg, icc_in_png, index_of, jpeg_of  # noqa: E402

try:
    import io
    from PIL import Image, ImageCms
except ImportError:                                  # pragma: no cover
    Image = ImageCms = None

SYSTEM_PROFILES = "/System/Library/ColorSync/Profiles/"
TEXT_SIGS = (b"desc", b"cprt", b"dmnd", b"dmdd", b"vued", b"dscm")
FORMS = {
    "two numbers far apart": "Shot 12.3456 " + "x" * 50 + " 65.4321",
    "two decimals": "12.35 65.43",
    "spaced numbers": "12 20 44 65 25 55",
    "degrees and minutes": "1220.44 06525.55",
    "numbers in words": "twelve degrees twenty minutes north sixty five degrees east",
    "letters and numbers": "N12 20 44 E65 25 55",
    "a plain place name": "Fakeville Harbour",
}
# (signature, type the original has)
TEXT_TAGS = ((b"desc", "desc"), (b"desc", "mluc"), (b"cprt", "text"), (b"cprt", "mluc"), (b"dmnd", "desc"), (b"dmnd", "mluc"), (b"dmdd", "desc"),
             (b"vued", "mluc"), (b"dscm", "mluc"))
NEUTRAL = {"desc": b"Profile", "cprt": b"No copyright"}


def icc_tags(profile):
    n = struct.unpack_from(">I", profile, 128)[0]
    out = []
    for i in range(n):
        sig, off, size = struct.unpack_from(">4sII", profile, 132 + 12 * i)
        out.append((sig, profile[off:off + size]))
    return out


def sent_profile(out, ct):
    if ct == JPEG:
        return locstrip._icc_of_jpeg(locstrip._jpeg_parts(out))
    return locstrip._png_icc(dict((k, b) for k, b, _c in locstrip._chunks(out))[b"iCCP"])


def with_text(sig, kind, text):
    data = LS.icc_text_tag(kind, text)
    if sig in (b"desc", b"cprt"):
        return LS.icc_profile(replace={sig: data})
    return LS.icc_profile(tags_extra=[(sig, data)])


def text_of(sig, data):
    """What a reader of the tag sees: the ASCII or UTF-16 words of the three layouts."""
    if data[:4] == b"mluc":
        return data[28:28 + struct.unpack_from(">I", data, 20)[0]].decode("utf-16-be").encode()
    if data[:4] == b"desc":
        return data[12:12 + struct.unpack_from(">I", data, 8)[0]].rstrip(b"\x00")
    return data[8:].rstrip(b"\x00")


class IccTextIsRewritten(Held):
    def check_one(self, profile, text, wrap, ct, label):
        out = self.copied(wrap(profile), ct)
        sent = sent_profile(out, ct)
        original, now = icc_tags(profile), icc_tags(sent)
        self.assertEqual([s for s, _d in original], [s for s, _d in now], label)
        for (sig, was), (_sig, is_) in zip(original, now):
            if sig in TEXT_SIGS:
                self.assertEqual(is_[:4], was[:4], (label, sig, "the same type"))
                self.assertEqual(text_of(sig, is_), NEUTRAL.get(sig.decode(), b"Profile") if sig != b"cprt" else NEUTRAL["cprt"], (label, sig))
                self.assertFalse([c for c in is_ if 0x30 <= c <= 0x39], (label, sig, "no digit"))
            else:
                self.assertEqual(is_, was, (label, sig, "colour tags are byte for byte"))
        for needle in (text.encode("latin-1"), text.encode("utf-16-be")):
            self.assertNotIn(needle, out, label)
            for piece in text.split():
                if len(piece) > 3:
                    self.assertNotIn(piece.encode("latin-1"), out, (label, piece))
                    self.assertNotIn(piece.encode("utf-16-be"), out, (label, piece))
        self.assertEqual(locstrip._rewrite_icc(sent), sent)
        return sent

    def test_every_form_in_every_text_tag_is_replaced_in_a_jpeg_and_in_a_png(self):
        for form, text in FORMS.items():
            for sig, kind in TEXT_TAGS:
                profile = with_text(sig, kind, text)
                label = "%s/%s/%s" % (form, sig.decode(), kind)
                self.check_one(profile, text, icc_in_jpeg, JPEG, "jpeg " + label)
                self.check_one(profile, text, icc_in_png, PNG, "png " + label)

    def test_the_words_in_every_text_tag_at_once_and_the_gaps_inside_them(self):
        text = FORMS["spaced numbers"]
        tags = [(b"dmnd", LS.icc_text_tag("desc", text)), (b"dmdd", LS.icc_text_tag("mluc", text)), (b"vued", LS.icc_text_tag("mluc", text)),
                (b"dscm", LS.icc_text_tag("mluc", text))]
        profile = LS.icc_profile(desc=text, cprt=text, tags_extra=tags)
        self.check_one(profile, text, icc_in_jpeg, JPEG, "jpeg all")
        self.check_one(profile, text, icc_in_png, PNG, "png all")
        # a desc whose Unicode and Macintosh parts carry words, and an mluc with more languages than one, and junk after its strings
        a = text.encode("latin-1") + b"\x00"
        desc = (b"desc\x00\x00\x00\x00" + struct.pack(">I", len(a)) + a + struct.pack(">II", 0x656E5553, len(text)) + text.encode("utf-16-be") + struct.pack(">HB", 0, 12)
                + b"Mac text 12.3" + bytes(67 - 13))
        two = text.encode("utf-16-be")
        mluc = (b"mluc\x00\x00\x00\x00" + struct.pack(">II", 2, 12) + b"enUS" + struct.pack(">II", len(two), 40) + b"deDE" + struct.pack(">II", len(two), 40 + len(two))
                + two + two + b"junk 65.4321")
        profile = LS.icc_profile(replace={b"desc": desc, b"cprt": mluc})
        self.check_one(profile, text, icc_in_jpeg, JPEG, "jpeg desc+mluc")
        self.check_one(profile, text, icc_in_png, PNG, "png desc+mluc")
        sent = sent_profile(self.copied(icc_in_jpeg(profile), JPEG), JPEG)
        mluc_sent = dict(icc_tags(sent))[b"cprt"]
        self.assertEqual(struct.unpack_from(">I", mluc_sent, 8)[0], 1, "one language")
        self.assertEqual(mluc_sent[16:20], b"enUS")

    def test_a_png_chunk_keyword_and_stream_are_written_again(self):
        text = FORMS["two decimals"]
        keyword = b"12.35 65.43"
        data = LS.png_image(pre=LS.chunk(b"iCCP", keyword + b"\x00\x00" + zlib.compress(with_text(b"desc", "mluc", text), 1)))
        out = self.copied(data, PNG)
        body = dict((k, b) for k, b, _c in locstrip._chunks(out))[b"iCCP"]
        self.assertEqual(body[:12], b"ICC Profile\x00")
        self.assertNotIn(keyword, out)

    def test_the_header_text_and_the_profile_id_cannot_carry_anything(self):
        profile = LS.icc_profile()
        for patch in ((4, b"lcms"), (40, b"APPL"), (48, b"ABCD"), (52, b"1234"), (80, b"Abc1")):
            sent = sent_profile(self.copied(icc_in_jpeg(LS.icc_profile(header_patch=patch)), JPEG), JPEG)
            self.assertEqual(sent[patch[0]:patch[0] + 4], bytes(4), patch)
        sent = sent_profile(self.copied(icc_in_jpeg(profile), JPEG), JPEG)
        self.assertEqual(sent[84:100], bytes(16))
        # a profile ID that is the MD5 of the profile is valid in the original and zero in the copy
        import hashlib
        zeroed = bytearray(profile)
        zeroed[44:48] = bytes(4)
        zeroed[64:68] = bytes(4)
        zeroed[84:100] = bytes(16)
        with_id = bytearray(profile)
        with_id[84:100] = hashlib.md5(bytes(zeroed)).digest()
        sent = sent_profile(self.copied(icc_in_png(bytes(with_id)), PNG), PNG)
        self.assertEqual(sent[84:100], bytes(16))

    def test_the_other_checks_of_round_4_still_hold(self):
        ui08 = b"ui08\x00\x00\x00\x00" + b"12.3456,65.4321" + b"\x00"
        for label, profile in {
            "ui08": LS.icc_profile(tags_extra=[(b"zzzz", ui08)]),
            "bytes between the tags": LS.icc_profile(gap=b"\x00\x00\x00\x00hidden text 12.3456"),
            "a wrong size field": LS.icc_profile(size_lie=4),
            "a technology signature that spells text": LS.icc_profile(tags_extra=[(b"tech", b"sig \x00\x00\x00\x00" + b"1234")]),
            "a mluc whose record points outside": LS.icc_profile(replace={b"desc": b"mluc\x00\x00\x00\x00" + struct.pack(">II", 1, 12) + b"enUS" + struct.pack(">II", 400, 28) + b"x" * 8}),
        }.items():
            self.held(icc_in_jpeg(profile), JPEG, "icc")
            self.held(icc_in_png(profile), PNG, "icc")
        self.copied(icc_in_jpeg(LS.icc_profile(tags_extra=[(b"tech", b"sig \x00\x00\x00\x00" + b"CRT ")])), JPEG)

    def test_a_profile_shared_data_and_a_tag_of_odd_size_keep_their_bytes(self):
        curve = b"curv\x00\x00\x00\x00" + struct.pack(">IH", 1, 0x0233) + b"\x00\x00"
        profile = LS.icc_profile(replace={b"rTRC": curve[:14], b"gTRC": curve[:14], b"bTRC": curve[:14]})
        sent = sent_profile(self.copied(icc_in_jpeg(profile), JPEG), JPEG)
        tags, was = dict(icc_tags(sent)), dict(icc_tags(profile))
        self.assertEqual((tags[b"rTRC"], tags[b"gTRC"], tags[b"bTRC"]), (was[b"rTRC"], was[b"gTRC"], was[b"bTRC"]))
        offsets = [struct.unpack_from(">I", sent, 132 + 12 * i + 4)[0] for i in range(struct.unpack_from(">I", sent, 128)[0])]
        self.assertTrue(all(o % 4 == 0 for o in offsets))
        self.assertEqual(len(sent) % 4, 0)

    def test_data_that_two_tags_share_stays_shared(self):
        buf = bytearray(LS.icc_profile())
        count = struct.unpack_from(">I", buf, 128)[0]
        where = {bytes(buf[132 + 12 * i:136 + 12 * i]): 132 + 12 * i for i in range(count)}
        r_off, r_size = struct.unpack_from(">II", buf, where[b"rTRC"] + 4)
        for sig in (b"gTRC", b"bTRC"):
            off, size = struct.unpack_from(">II", buf, where[sig] + 4)
            buf[off:off + size] = bytes(size)                      # the copy it had is a gap now: zero
            struct.pack_into(">II", buf, where[sig] + 4, r_off, r_size)
        out = self.copied(icc_in_jpeg(bytes(buf)), JPEG)
        sent = sent_profile(out, JPEG)
        spots = {}
        for i in range(struct.unpack_from(">I", sent, 128)[0]):
            sig, off, size = struct.unpack_from(">4sII", sent, 132 + 12 * i)
            spots[sig] = (off, size)
        self.assertEqual(spots[b"rTRC"], spots[b"gTRC"])
        self.assertEqual(spots[b"rTRC"], spots[b"bTRC"])
        self.assertEqual(locstrip._rewrite_icc(sent), sent)

    def test_a_big_profile_goes_in_several_app2_segments_and_back(self):
        points = list(range(0, 65536, 16))
        big = struct.pack(">I", len(points))
        curve = b"curv\x00\x00\x00\x00" + big + struct.pack(">%dH" % len(points), *points)
        profile = LS.icc_profile(replace={b"rTRC": curve, b"gTRC": curve, b"bTRC": curve})
        out = self.copied(icc_in_jpeg(profile), JPEG)
        parts = [p for m, p in locstrip._jpeg_parts(out) if m == 0xE2]
        self.assertEqual(parts, locstrip._icc_segments(sent_profile(out, JPEG)))
        self.assertEqual(dict(icc_tags(sent_profile(out, JPEG)))[b"rTRC"], curve)

    @unittest.skipIf(Image is None, "Pillow is not installed")
    def test_pillow_reads_the_profile_and_converts_the_pixels_as_before(self):
        text = FORMS["spaced numbers"]
        profile = LS.icc_profile(desc=text, cprt=text)
        sent = sent_profile(self.copied(icc_in_jpeg(profile), JPEG), JPEG)
        srgb = ImageCms.createProfile("sRGB")
        image = Image.new("RGB", (8, 8))
        image.putdata([((x * 30) % 256, (y * 30) % 256, ((x + y) * 17) % 256) for y in range(8) for x in range(8)])
        try:
            was = ImageCms.profileToProfile(image, ImageCms.ImageCmsProfile(io.BytesIO(profile)), srgb)
        except ImageCms.PyCMSError:
            self.skipTest("lcms does not take the synthetic profile")
        now = ImageCms.profileToProfile(image, ImageCms.ImageCmsProfile(io.BytesIO(sent)), srgb)
        self.assertEqual(now.tobytes(), was.tobytes())
        self.assertEqual(ImageCms.ImageCmsProfile(io.BytesIO(sent)).profile.profile_description, "Profile")

    def test_the_system_profiles_are_copied_with_their_colour_tags_unchanged(self):
        paths = sorted(glob.glob(SYSTEM_PROFILES + "*.icc") + glob.glob(SYSTEM_PROFILES + "*.icm"))
        if not paths:
            self.skipTest("no system colour profiles to read")
        for path in paths:
            with open(path, "rb") as fh:
                profile = fh.read()
            for wrap, ct in ((icc_in_jpeg, JPEG), (icc_in_png, PNG)):
                out = locstrip.strip(wrap(profile), ct)[0]
                self.assertIsNotNone(out, path)
                sent = sent_profile(out, ct)
                self.assertEqual([(s, d) for s, d in icc_tags(sent) if s not in TEXT_SIGS], [(s, d) for s, d in icc_tags(profile) if s not in TEXT_SIGS], path)
                self.assertEqual(locstrip._rewrite_icc(sent), sent, path)

    @unittest.skipUnless(os.path.exists("/usr/bin/sips") and os.path.isdir(SYSTEM_PROFILES), "sips and the system profiles are not here")
    @unittest.skipIf(Image is None, "Pillow is not installed")
    def test_sips_loads_the_rewritten_profile_and_converts_the_pixels_as_before(self):
        work = tempfile.mkdtemp(prefix="hfy-icc-")
        try:
            image = Image.new("RGB", (24, 24))
            image.putdata([((x * 11) % 256, (y * 9) % 256, ((x * y) * 3) % 256) for y in range(24) for x in range(24)])
            target = SYSTEM_PROFILES + "sRGB Profile.icc"
            for name in ("Display P3.icc", "AdobeRGB1998.icc", "ROMM RGB.icc"):
                path = SYSTEM_PROFILES + name
                if not os.path.exists(path):
                    continue
                with open(path, "rb") as fh:
                    profile = fh.read()
                made = {}
                for label, blob in (("was", profile), ("now", locstrip._rewrite_icc(profile))):
                    src = os.path.join(work, label + ".png")
                    dst = os.path.join(work, label + "-out.png")
                    image.save(src, "PNG", icc_profile=blob)
                    done = subprocess.run(["/usr/bin/sips", "-m", target, src, "--out", dst], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
                    self.assertEqual(done.returncode, 0, (name, label, done.stderr[:200]))
                    made[label] = Image.open(dst).convert("RGB").tobytes()
                self.assertEqual(made["now"], made["was"], name)
        finally:
            shutil.rmtree(work, ignore_errors=True)


def dqt_spelling(text):
    def edit(parts):
        i = index_of(parts, 0xDB)
        payload = bytearray(parts[i][1])
        payload[10:10 + len(text)] = text
        parts[i] = (0xDB, bytes(payload))
    return edit


class SmallCovertChannels(Held):
    def test_a_quantisation_table_that_spells_digits_without_a_dot_is_held(self):
        for text in (b"12 20 44 65 25 55", b"122044655255", b"12,20,44/65-25-55", b"12 20 44 / 65 25 55", b"12.3456", b"65.4321", b"1220.44 06525.55"):
            self.held(jpeg_of(LS.BASELINE, dqt_spelling(text)), JPEG, "structure")
        self.copied(jpeg_of(LS.BASELINE, dqt_spelling(b"2222222222222222")), JPEG)       # one repeated value is a flat table, not text

    @unittest.skipIf(Image is None, "Pillow is not installed")
    def test_the_tables_of_every_quality_an_encoder_writes_are_not_text(self):
        image = Image.new("RGB", (32, 24))
        image.putdata([((x * 7 + y) % 256, (y * 9) % 256, (x * y) % 256) for y in range(24) for x in range(32)])
        for quality in list(range(1, 101, 3)) + [75, 90, 95, 100]:
            for kwargs in ({}, {"subsampling": 0}, {"optimize": True}):
                buf = io.BytesIO()
                image.save(buf, "JPEG", quality=quality, **kwargs)
                jpg = buf.getvalue()
                data = jpg[:2] + LS.segment(0xE1, b"Exif\x00\x00" + GPS_EXIF) + jpg[2:]
                self.copied(data, JPEG)
        buf = io.BytesIO()
        image.convert("L").save(buf, "JPEG", quality=75)
        jpg = buf.getvalue()
        self.copied(jpg[:2] + LS.segment(0xE1, b"Exif\x00\x00" + GPS_EXIF) + jpg[2:], JPEG)

    def png_of(self, width, height, depth, rows, interlace=0):
        """A grayscale PNG of ``depth`` bits whose scanlines are the (filter type, filtered bytes) of ``rows``."""
        raw = b"".join(bytes([f]) + row for f, row in rows)
        head = b"\x89PNG\r\n\x1a\n" + LS.chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, depth, 0, 0, 0, interlace))
        return head + LS.chunk(b"eXIf", GPS_EXIF) + LS.chunk(b"IDAT", zlib.compress(raw, 9)) + LS.chunk(b"IEND", b"")

    @staticmethod
    def filtered(ftype, row, prior):
        """The filtered bytes of ``row`` (bytes per pixel 1) for a filter type 0 to 4."""
        out = bytearray()
        for i, cur in enumerate(row):
            left = row[i - 1] if i else 0
            up = prior[i]
            corner = prior[i - 1] if i else 0
            if ftype == 0:
                guess = 0
            elif ftype == 1:
                guess = left
            elif ftype == 2:
                guess = up
            elif ftype == 3:
                guess = (left + up) >> 1
            else:
                base = left + up - corner
                da, db, dc = abs(base - left), abs(base - up), abs(base - corner)
                guess = left if da <= db and da <= dc else (up if db <= dc else corner)
            out.append((cur - guess) & 255)
        return bytes(out)

    def test_the_unused_bits_of_a_row_of_a_1_2_or_4_bit_image_must_be_zero_after_the_filter_is_undone(self):
        rng = random.Random(5)
        for depth, width in ((1, 11), (2, 5), (4, 3), (1, 3)):
            nbytes = -(-width * depth // 8)
            pad = nbytes * 8 - width * depth
            mask = (1 << pad) - 1
            for ftypes in ((0, 0, 0), (1, 2, 3), (4, 4, 1), (3, 4, 2), (2, 3, 4)):
                recon = [bytes(rng.randrange(256) & ~mask & 255 for _ in range(nbytes)) for _ in ftypes]
                for dirty in (False, True):
                    rows_bytes = list(recon)
                    if dirty:
                        k = rng.randrange(len(ftypes))
                        rows_bytes[k] = rows_bytes[k][:-1] + bytes([rows_bytes[k][-1] | (1 << rng.randrange(pad))])
                    rows, prior = [], bytes(nbytes)
                    for f, row in zip(ftypes, rows_bytes):
                        rows.append((f, self.filtered(f, row, prior)))
                        prior = row
                    data = self.png_of(width, len(ftypes), depth, rows)
                    if dirty:
                        self.held(data, PNG, "structure")
                    else:
                        self.copied(data, PNG)

    def test_the_unused_bits_of_an_interlaced_low_depth_image_and_a_width_that_has_none(self):
        self.copied(LS.png_image(width=11, height=9, ctype=0, depth=1, interlace=1, filler=0), PNG)
        self.held(LS.png_image(width=11, height=9, ctype=0, depth=1, interlace=1, filler=0xFF), PNG, "structure")
        self.held(LS.png_image(width=5, height=4, ctype=0, depth=2, filler=0x03), PNG, "structure")
        self.copied(LS.png_image(width=8, height=4, ctype=0, depth=1, filler=0xFF), PNG)           # eight 1-bit pixels fill the byte: no unused bit
        self.copied(LS.png_image(width=8, height=4, ctype=0, depth=8, filler=0xFF), PNG)


if __name__ == "__main__":
    unittest.main()
