"""Media files up and the file checks (task addon-media, HFY-TSK-207): checksums, the signed SHA-256 upload through the staging key, the
holds for files that cannot go, rects that survive a round trip, and the EXIF check. Standard library only; no Gramps and no network.

    python3 -m unittest gramps/tests/unit/test_addon_media_up.py

The website is push_support.FakeCloud (it enforces the signed type, length and SHA-256 of a PUT, keeps a staging area and the served
keys apart, and finalizes a staged blob only after the Media op commits, as api/src/sync/media.js does). Files are real files in a
temporary folder; every byte and value is synthetic. The same flows run against the real dev server in tests/e2e/scenario_media.py.
"""
import base64
import copy
import hashlib
import json
import os
import random
import shutil
import struct
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import push_support as PS  # noqa: E402
from test_addon_push import PushCase  # noqa: E402
from hfygramps.addon import consts, mediafile, mediaup  # noqa: E402

FIXTURE_MEDIA = os.path.join(PS.GRAMPS, "tests", "fixtures", "media")
JFIF = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"


def jpeg(tag):
    """A small synthetic JPEG with no metadata; `tag` makes its bytes unique."""
    return JFIF + b"\xff\xdb\x00\x05" + tag.encode("ascii")[:3].ljust(3, b".") + b"\xff\xda\x00\x04\x00\x00synthetic-" + tag.encode("ascii") + b"\xff\xd9"


def tiff_with_gps(big=False, zero=False):
    """A TIFF whose IFD0 points at a GPS IFD holding GPSLatitude (and GPSLongitude)."""
    e = ">" if big else "<"
    head = (b"MM\x00*" if big else b"II*\x00") + struct.pack(e + "I", 8)
    ifd0 = struct.pack(e + "H", 1) + struct.pack(e + "HHII", 0x8825, 4, 1, 26) + struct.pack(e + "I", 0)   # 8 + 2 + 12 + 4 = 26
    gps = struct.pack(e + "H", 1) + struct.pack(e + "HHII", 0x0002, 5, 3, 44) + struct.pack(e + "I", 0)    # 26 + 2 + 12 + 4 = 44
    num, den = (0, 1) if zero else (12, 1)
    rationals = b"".join(struct.pack(e + "II", num, den) for _ in range(3))
    return head + ifd0 + gps + rationals


def exif_jpeg(tiff):
    app1 = b"Exif\x00\x00" + tiff
    return JFIF + b"\xff\xe1" + struct.pack(">H", len(app1) + 2) + app1 + b"\xff\xdb\x00\x05abc\xff\xda\x00\x04\x00\x00data\xff\xd9"


def png_with_exif(tiff):
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + b"\x00\x00\x00\x00"
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", b"\x00" * 13) + chunk(b"eXIf", tiff) + chunk(b"IDAT", b"x") + chunk(b"IEND", b"")


class FileChecks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hfy-media-files-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def write(self, name, data):
        path = os.path.join(self.tmp, name)
        with open(path, "wb") as fh:
            fh.write(data)
        return path

    def test_the_content_type_comes_from_the_bytes_not_the_name(self):
        self.assertEqual(mediafile.sniff(jpeg("a")), "image/jpeg")
        self.assertEqual(mediafile.sniff(b"\x89PNG\r\n\x1a\nxx"), "image/png")
        self.assertEqual(mediafile.sniff(b"GIF89a.."), "image/gif")
        self.assertEqual(mediafile.sniff(b"II*\x00...."), "image/tiff")
        self.assertEqual(mediafile.sniff(b"MM\x00*...."), "image/tiff")
        self.assertEqual(mediafile.sniff(b"%PDF-1.4"), "application/pdf")
        self.assertIsNone(mediafile.sniff(b"RIFF....WEBPVP8 "))
        self.assertIsNone(mediafile.sniff(b"\x00\x00\x00\x18ftypheic"))

    def test_the_fixture_photo_with_a_location_is_found_and_the_plain_one_is_not(self):
        got = mediafile.inspect(os.path.join(FIXTURE_MEDIA, "synthetic-photo-gps.jpg"))
        self.assertEqual((got["state"], got["exif_gps"], got["content_type"]), ("gps", True, "image/jpeg"))
        plain = mediafile.inspect(os.path.join(FIXTURE_MEDIA, "synthetic-photo-plain.jpg"))
        self.assertEqual((plain["state"], plain["exif_gps"]), ("ok", False))
        with open(os.path.join(FIXTURE_MEDIA, "synthetic-photo-plain.jpg"), "rb") as fh:
            self.assertEqual(plain["md5"], hashlib.md5(fh.read()).hexdigest())

    def test_gps_is_found_in_jpeg_png_and_tiff_in_both_byte_orders(self):
        for big in (False, True):
            self.assertTrue(mediafile.exif_gps(tiff_with_gps(big), "image/tiff"))
            self.assertTrue(mediafile.exif_gps(exif_jpeg(tiff_with_gps(big)), "image/jpeg"))
            self.assertTrue(mediafile.exif_gps(png_with_exif(tiff_with_gps(big)), "image/png"))
        self.assertFalse(mediafile.exif_gps(tiff_with_gps(zero=True), "image/tiff"), "a (0, 0, 0) position is not a position")
        self.assertFalse(mediafile.exif_gps(jpeg("a"), "image/jpeg"))
        self.assertFalse(mediafile.exif_gps(b"%PDF-1.4 GPS", "application/pdf"), "a PDF has no EXIF")

    def test_gps_is_found_wherever_the_exif_header_sits_and_in_plain_xmp(self):
        buried = b"\xff\xd8\xff\xfe\x00\x03x" + b"junk" * 5 + b"Exif\x00\x00" + tiff_with_gps()
        self.assertTrue(mediafile.exif_gps(buried, "image/jpeg"), "a JPEG whose segments lose sync is still scanned for an EXIF header")
        xmp = b"http://ns.adobe.com/xap/1.0/\x00<x:xmpmeta><rdf:Description exif:GPSLatitude=\"1,2N\"/></x:xmpmeta>"
        self.assertTrue(mediafile.exif_gps(JFIF + b"\xff\xe1" + struct.pack(">H", len(xmp) + 2) + xmp + b"\xff\xd9", "image/jpeg"))

    def test_exif_that_cannot_be_read_counts_as_a_position(self):
        tiff = tiff_with_gps()
        cut = tiff[:30]                                                   # the GPS IFD is outside what is there
        self.assertTrue(mediafile.tiff_has_gps(cut, 0, len(cut)))
        bad_type = bytearray(tiff)
        bad_type[34:36] = struct.pack("<H", 2)                            # GPSLatitude of type ASCII
        self.assertTrue(mediafile.tiff_has_gps(bytes(bad_type)))

    def test_states_of_a_file(self):
        self.assertEqual(mediafile.inspect(os.path.join(self.tmp, "nothing.jpg"))["state"], "missing")
        self.assertEqual(mediafile.inspect("")["state"], "missing")
        self.assertEqual(mediafile.inspect(self.tmp)["state"], "missing", "a folder is not a file")
        empty = mediafile.inspect(self.write("empty.jpg", b""))
        self.assertEqual((empty["state"], empty["readable"], empty["md5"]), ("empty", False, ""))
        odd = mediafile.inspect(self.write("heic.heic", b"\x00\x00\x00\x18ftypheic" + b"x" * 40))
        self.assertEqual((odd["state"], odd["readable"]), ("unsupported", True))
        good = mediafile.inspect(self.write("ok.jpg", jpeg("a")))
        self.assertEqual((good["state"], good["content_type"], good["size"], good["readable"]), ("ok", "image/jpeg", len(jpeg("a")), True))
        self.assertEqual(good["sha256"], hashlib.sha256(jpeg("a")).hexdigest())
        self.assertEqual(good["md5"], hashlib.md5(jpeg("a")).hexdigest())

    def test_a_file_over_25_mb_is_not_read_into_memory_and_gets_only_an_md5(self):
        path = self.write("big.jpg", JFIF)
        with open(path, "r+b") as fh:
            fh.truncate(mediafile.MAX_BYTES + 1)
        got = mediafile.inspect(path)
        self.assertEqual((got["state"], got["readable"], got["sha256"]), ("too_large", True, ""))
        self.assertEqual(len(got["md5"]), 32)

    def test_a_dropbox_placeholder_is_detected_without_reading_it(self):
        path = self.write("online-only.jpg", jpeg("a"))
        with mock.patch.object(mediafile, "xattr_names", return_value=["com.apple.quarantine", mediafile.PLACEHOLDER_XATTR]):
            got = mediafile.inspect(path)
        self.assertEqual((got["state"], got["readable"], got["md5"], got["sha256"]), ("placeholder", False, "", ""))
        self.assertEqual(mediafile.inspect(path)["state"], "ok", "without the attribute the same file is fine")

    def test_the_real_extended_attribute_marks_a_placeholder(self):
        if sys.platform != "darwin":
            self.skipTest("the xattr command and the macOS attribute calls are the Mac's")
        import subprocess
        path = self.write("marked.jpg", jpeg("a"))
        if subprocess.run(["xattr", "-w", mediafile.PLACEHOLDER_XATTR, "1", path], capture_output=True).returncode != 0:
            self.skipTest("xattr is not usable here")
        self.assertIn(mediafile.PLACEHOLDER_XATTR, mediafile.xattr_names(path))
        self.assertEqual(mediafile.inspect(path)["state"], "placeholder")

    def test_a_macos_dataless_file_is_a_placeholder(self):
        path = self.write("dataless.jpg", jpeg("a"))
        st = os.stat(path)
        fake = mock.Mock(wraps=st, st_flags=mediafile.SF_DATALESS, st_size=st.st_size)
        self.assertEqual(mediafile.placeholder_reason(path, fake), "placeholder")

    def test_base_path_mapping(self):
        base = os.path.join(self.tmp, "Family Media")
        self.assertEqual(mediafile.resolve("2020/x.jpg", base), os.path.join(base, "2020", "x.jpg"))
        self.assertEqual(mediafile.resolve("/abs/x.jpg", base), "/abs/x.jpg")
        self.assertEqual(mediafile.resolve("", base), "")
        self.assertEqual(mediafile.resolve(None, base), "")
        with mock.patch.dict(os.environ, {"HOME": self.tmp}):
            self.assertEqual(mediafile.resolve("~/p/x.jpg", base), os.path.join(self.tmp, "p", "x.jpg"))
            self.assertEqual(mediafile.resolve("x.jpg", "~/Base"), os.path.join(self.tmp, "Base", "x.jpg"))

    def test_collect_reads_every_media_object_by_its_resolved_path(self):
        self.write("a.jpg", jpeg("a"))
        got = mediafile.collect([{"handle": "h1", "path": "a.jpg"}, {"handle": "h2", "path": "gone.jpg"}, {"handle": "", "path": "a.jpg"}], self.tmp)
        self.assertEqual({h: i["state"] for h, i in got.items()}, {"h1": "ok", "h2": "missing"})

    def test_a_held_download_has_a_rule(self):
        self.assertEqual(mediafile.hold_for_bytes(b""), "media_blob_empty")
        self.assertEqual(mediafile.hold_for_bytes(exif_jpeg(tiff_with_gps())), "media.exif_gps.hold")
        self.assertIsNone(mediafile.hold_for_bytes(jpeg("a")))


class MediaPush(PushCase):
    """The full fixture pushed from real files: the fixture's own six, and new synthetic photos."""

    full = True
    tree_class = PS.MediaPushTree

    def setUp(self):
        PushCase.setUp(self)
        self.base = os.path.join(self.tmp, "media-base")
        shutil.copytree(FIXTURE_MEDIA, os.path.join(self.base, "media"))
        self.tree.media_base = self.base
        self.n_photo = 0

    # ---- helpers
    def file_of(self, obj):
        return os.path.join(self.base, obj["path"])

    def write_file(self, rel, data):
        path = os.path.join(self.base, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)
        return path

    def media(self, gid):
        return self.tree.by_id("Media", gid)

    def add_photo(self, data, gid="O0100", rect=None, person="I0002", mime="image/jpeg", checksum=None, name=None):
        """A new Media object with a file of its own, tagged on a person with `rect`. Returns the Media handle."""
        self.n_photo += 1
        name = name or "new/photo%d.jpg" % self.n_photo
        self.write_file(name, data)
        template = copy.deepcopy(self.media("O0001"))
        handle = "e%026d" % self.n_photo
        template.update(handle=handle, gramps_id=gid, path=name, mime=mime, desc="A new synthetic photo",
                        checksum=checksum or hashlib.md5(data).hexdigest(), private=False)
        self.tree.data[handle] = template
        owner = self.tree.person_by_id(person)
        ref = copy.deepcopy(owner["media_list"][0]) if owner["media_list"] else copy.deepcopy(self.tree.person_by_id("I0003")["media_list"][0])
        ref.update(ref=handle, rect=rect, private=False)
        owner["media_list"] = owner["media_list"] + [ref]
        return handle

    def assertNoReferenceTo(self, media_handle):
        """No object the website holds names a Media it does not have (the person that tagged the held photo was still pushed)."""
        person = self.cloud.heads[self.tree.person_by_id("I0002")["handle"]]["obj"]
        self.assertNotIn(media_handle, json.dumps(person), "the pushed person has no reference to the held Media")
        self.assertNotIn(media_handle, json.dumps([h["obj"] for h in self.cloud.heads.values() if h.get("obj")]))

    def heads_media(self):
        return {h: hd for h, hd in self.cloud.heads.items() if hd["class"] == "Media" and not hd["deleted"]}

    def holds(self, cls="Media"):
        return sorted(self.rows("SELECT handle, rule, path FROM holds WHERE class = ?", cls))

    # ---- AC 1: a new photo with a tagged MediaRef uploads with a signed sha256 ----------------------------------------------------

    def test_a_new_photo_with_a_tagged_rect_uploads_with_a_signed_sha256_and_the_head_records_the_blob(self):
        self.seed()
        data = jpeg("one")
        handle = self.add_photo(data, rect=[10, 20, 60, 80])
        doc = self.push()
        self.assertEqual((doc["result"], doc["counts"]["media_up"]), ("partial", 1), "the fixture's own held files keep the run partial")
        key, headers, size = self.cloud.puts[-1]
        self.assertEqual(key, "media/.staging/%s/%s" % (handle, hashlib.sha256(data).hexdigest()))
        self.assertEqual(headers["x-amz-checksum-sha256"], base64.b64encode(hashlib.sha256(data).digest()).decode("ascii"))
        self.assertEqual((headers["Content-Type"], size), ("image/jpeg", len(data)))
        self.assertNotIn("Authorization", headers, "the bearer token never goes to the blob store")
        blob = self.cloud.blobs[handle]
        self.assertEqual((blob["sha256"], blob["md5"], blob["size"], blob["state"]),
                         (hashlib.sha256(data).hexdigest(), hashlib.md5(data).hexdigest(), len(data), "present"))
        self.assertEqual(self.cloud.final["media/%s.jpg" % handle], data)
        self.assertNotIn("media/.staging/%s/%s" % (handle, hashlib.sha256(data).hexdigest()), self.cloud.staging, "the staging object is finalized away")
        person = self.cloud.heads[self.tree.person_by_id("I0002")["handle"]]["obj"]
        self.assertEqual([r["rect"] for r in person["media_list"] if r["ref"] == handle], [[10, 20, 60, 80]], "the rect is the same four integers")
        self.assertEqual(self.cloud.heads[handle]["obj"]["checksum"], hashlib.md5(data).hexdigest())
        self.cloud.check_blob_invariant()

    def test_the_media_op_names_the_blob_and_the_path_never_leaves_the_machine(self):
        self.seed()
        handle = self.add_photo(jpeg("two"), rect=None)
        self.push()
        op = next(o for o in self.cloud.pushed_ops() if o["handle"] == handle)
        self.assertEqual(set(op["blob"]), {"sha256", "md5", "size", "content_type"})
        self.assertEqual(op["obj"]["path"], "")
        self.assertNotIn(self.base, self.cloud.log_text())
        self.assertNotIn("new/photo", self.cloud.log_text())

    def test_a_second_push_uploads_nothing_and_the_sidecar_remembers_the_bytes(self):
        self.seed()
        data = jpeg("three")
        handle = self.add_photo(data)
        self.push()
        presigns = len(self.cloud.presigns)
        doc = self.push()
        self.assertEqual((doc["result"], doc["counts"]["media_up"], len(self.cloud.presigns)), (doc["result"], 0, presigns))
        row = self.rows("SELECT md5, sha256, size, origin FROM media_local WHERE handle = ?", handle)
        self.assertEqual(row, [(hashlib.md5(data).hexdigest(), hashlib.sha256(data).hexdigest(), len(data), "up")])

    def test_the_fixture_photo_is_uploaded_and_its_bytes_match(self):
        self.seed()
        plain = self.media("O0001")
        with open(self.file_of(plain), "rb") as fh:
            data = fh.read()
        self.assertEqual(self.cloud.blob_bytes(plain["handle"]), data)
        self.assertEqual(self.cloud.blobs[plain["handle"]]["md5"], plain["checksum"], "the fixture's Gramps checksum is the disk MD5")
        self.cloud.check_blob_invariant()

    # ---- AC 3: files that cannot go are held with guidance --------------------------------------------------------------------------

    def test_the_fixture_gps_photo_the_placeholder_and_the_pdf_are_held_with_guidance(self):
        self.seed()
        gps, placeholder, pdf = self.media("O0002"), self.media("O0003"), self.media("O0004")
        self.assertNotIn(gps["handle"], self.cloud.heads, "a photo with a GPS location is not sent at all")
        self.assertNotIn(pdf["handle"], self.cloud.heads, "a PDF stays until io releases it")
        self.assertIn(placeholder["handle"], self.cloud.heads, "the placeholder's metadata syncs")
        self.assertNotIn(placeholder["handle"], self.cloud.blobs, "and no blob is invented for it")
        rules = {h: r for h, r, _p in self.holds()}
        self.assertEqual(rules[gps["handle"]], "media.exif_gps.hold")
        self.assertEqual(rules[placeholder["handle"]], "media_blob_empty")
        details = {h: d for h, d in self.rows("SELECT handle, detail FROM holds WHERE class = 'Media'")}
        self.assertIn("location", details[gps["handle"]])
        self.assertIn("offline", details[placeholder["handle"]])
        self.assertNotIn(self.base, " ".join(details.values()))

    def test_a_dropbox_online_only_file_is_held_and_its_metadata_syncs(self):
        self.seed()
        data = jpeg("four")
        handle = self.add_photo(data)
        with mock.patch.object(mediafile, "xattr_names", lambda p: [mediafile.PLACEHOLDER_XATTR] if p.endswith("photo1.jpg") else []):
            doc = self.push()
        self.assertIn(handle, self.cloud.heads)
        self.assertNotIn(handle, self.cloud.blobs)
        op = next(o for o in self.cloud.pushed_ops() if o["handle"] == handle)
        self.assertEqual(op["blob"], {"state": "missing"})
        self.assertIn((handle, "media_blob_placeholder", "/blob"), self.holds())
        self.assertEqual(doc["counts"]["media_up"], 0)
        self.assertEqual(self.cloud.heads[handle]["obj"]["checksum"], hashlib.md5(data).hexdigest(), "the stored checksum stands in for a file that was not read")

    def test_when_the_file_becomes_available_the_blob_goes_up_in_an_update_of_its_own(self):
        self.seed()
        data = jpeg("five")
        handle = self.add_photo(data)
        with mock.patch.object(mediafile, "xattr_names", lambda p: [mediafile.PLACEHOLDER_XATTR] if p.endswith("photo1.jpg") else []):
            self.push()
        version = self.cloud.heads[handle]["version"]
        doc = self.push()                                   # the folder is now available offline: nothing is mocked
        self.assertEqual(doc["counts"]["media_up"], 1, doc)
        self.assertEqual(self.cloud.blob_bytes(handle), data)
        self.assertEqual(self.cloud.heads[handle]["version"], version + 1)
        self.assertNotIn((handle, "media_blob_placeholder", "/blob"), self.holds(), "the hold is released")
        self.cloud.check_blob_invariant()

    def test_a_good_cloud_blob_is_never_replaced_by_an_empty_file(self):
        self.seed()
        data = jpeg("six")
        handle = self.add_photo(data)
        self.push()
        path = self.file_of(self.tree.data[handle])
        open(path, "wb").close()                            # the file is now 0 bytes
        self.tree.edit(handle, lambda m: m.update(desc="A new description"))
        self.push()
        self.assertEqual(self.cloud.heads[handle]["obj"]["desc"], "A new description", "the metadata edit synced")
        self.assertEqual(self.cloud.blob_bytes(handle), data, "the served bytes are the good ones")
        self.assertEqual(self.cloud.blobs[handle]["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(next(o for o in reversed(self.cloud.pushed_ops()) if o["handle"] == handle).get("blob"), None,
                         "nothing about the blob was sent: the website keeps what it has")
        self.assertNotIn((handle, "media_blob_empty", "/blob"), self.holds(), "the cloud copy is good, so there is nothing for io to fix")

    def test_a_file_that_went_bad_after_it_synced_is_a_warning_not_a_hold(self):
        self.seed()
        handle = self.add_photo(jpeg("six2"))
        self.push()
        open(self.file_of(self.tree.data[handle]), "wb").close()
        self.tree.edit(handle, lambda m: m.update(desc="Changed once more"))
        doc = self.push(dry_run=True)
        with open(self.preview_path(doc), encoding="utf-8") as fh:
            preview = json.load(fh)
        self.assertEqual([(w["rule"], w["handle"]) for w in preview["warnings"]], [("media_cloud_copy_differs", handle)])
        self.assertNotIn((handle, "media_blob_empty", "/blob"), self.holds())

    def test_a_file_that_is_missing_or_unsupported_is_held(self):
        self.seed()
        gone = self.add_photo(jpeg("seven"), gid="O0101")
        os.unlink(self.file_of(self.tree.data[gone]))
        odd = self.add_photo(b"\x00\x00\x00\x18ftypheic" + b"x" * 40, gid="O0102", name="new/odd.heic", mime="image/heic")
        self.push()
        rules = {h: r for h, r, _p in self.holds()}
        self.assertEqual((rules[gone], rules[odd]), ("media_blob_missing", "media_blob_unsupported"))
        self.assertEqual(self.cloud.blobs.get(gone), None)
        self.assertIn(gone, self.cloud.heads)

    def test_a_photo_with_a_location_is_held_by_its_bytes_even_when_the_mime_is_blank(self):
        self.seed()
        handle = self.add_photo(exif_jpeg(tiff_with_gps()), gid="O0103", mime="")
        self.push()
        self.assertNotIn(handle, self.cloud.heads)
        self.assertIn((handle, "media.exif_gps.hold", ""), self.holds())
        self.assertEqual([p for p in self.cloud.puts if handle in p[0]], [])
        self.assertNoReferenceTo(handle)

    def test_a_pdf_the_mime_does_not_admit_to_is_held_by_its_bytes(self):
        self.seed()
        handle = self.add_photo(b"%PDF-1.4\nsynthetic\n%%EOF", gid="O0104", mime="", name="new/scan.pdf")
        self.push()
        self.assertNotIn(handle, self.cloud.heads)
        self.assertIn((handle, "media.pdf.hold", ""), self.holds())
        self.assertNoReferenceTo(handle)

    # ---- AC 4: checksums --------------------------------------------------------------------------------------------------------

    def test_a_stale_gramps_md5_gives_a_warning_and_the_disk_md5_is_used(self):
        self.seed()
        data = jpeg("eight")
        handle = self.add_photo(data, checksum="0" * 32)
        doc = self.push(dry_run=True)
        with open(self.preview_path(doc), encoding="utf-8") as fh:
            preview = json.load(fh)
        self.assertEqual([(w["rule"], w["handle"]) for w in preview["warnings"]], [("media_checksum_stale", handle)])
        self.assertNotIn("0" * 32, json.dumps(preview), "the warning names the object, not the values")
        self.assertEqual(preview["counts"]["media_up"], 1)
        self.push()
        self.assertEqual(self.cloud.heads[handle]["obj"]["checksum"], hashlib.md5(data).hexdigest())
        self.assertEqual(self.cloud.blobs[handle]["md5"], hashlib.md5(data).hexdigest())
        self.assertEqual(self.tree.data[handle]["checksum"], "0" * 32, "the Gramps tree is not touched: the push only reads")

    def preview_path(self, doc):
        from hfygramps.addon import paths
        return os.path.join(paths.TreePaths(self.tree.dbid, self.env).previews, "%s.json" % doc["run_id"])

    # ---- AC 5: staging, finalize after the commit, the forced 409 ------------------------------------------------------------------

    def test_a_changed_file_goes_to_the_staging_key_and_replaces_the_served_blob_only_with_its_op(self):
        self.seed()
        old = jpeg("nine")
        handle = self.add_photo(old)
        self.push()
        new = jpeg("ten")
        self.write_file(self.tree.data[handle]["path"], new)
        self.tree.edit(handle, lambda m: m.update(checksum=hashlib.md5(new).hexdigest()))
        seen = {}
        original = self.cloud._batch

        def spying(body, key):
            seen["before"] = (dict(self.cloud.staging), self.cloud.blob_bytes(handle))
            return original(body, key)
        self.cloud._batch = spying
        self.push()
        staged, served_then = seen["before"]
        self.assertEqual(staged["media/.staging/%s/%s" % (handle, hashlib.sha256(new).hexdigest())], new, "the new bytes were staged before the op")
        self.assertEqual(served_then, old, "and the served key still held the old bytes when the op arrived")
        self.assertEqual(self.cloud.blob_bytes(handle), new)
        self.assertEqual(self.cloud.blobs[handle]["sha256"], hashlib.sha256(new).hexdigest())
        self.cloud.check_blob_invariant()

    def test_a_409_after_the_upload_leaves_the_served_blob_and_its_metadata_as_they_were(self):
        self.seed()
        old = jpeg("eleven")
        handle = self.add_photo(old)
        self.push()
        before_head = copy.deepcopy(self.cloud.heads[handle])
        new = jpeg("twelve")
        self.write_file(self.tree.data[handle]["path"], new)
        self.tree.edit(handle, lambda m: m.update(checksum=hashlib.md5(new).hexdigest(), desc="Edited on the desktop"))
        self.cloud.on_batch = lambda: self.cloud.edit(handle, lambda o: o.update(desc="Edited on the website"))   # a website edit races the push
        doc = self.push()
        self.assertEqual(doc["exit_code"], consts.EXIT_TEMPORARY, doc)
        self.assertIn("media/.staging/%s/%s" % (handle, hashlib.sha256(new).hexdigest()), self.cloud.staging, "the bytes were uploaded")
        self.assertEqual(self.cloud.blob_bytes(handle), old, "but they were never served")
        self.assertEqual(self.cloud.blobs[handle]["sha256"], hashlib.sha256(old).hexdigest())
        self.assertEqual(self.cloud.heads[handle]["obj"]["desc"], "Edited on the website")
        self.assertEqual(self.cloud.heads[handle]["obj"]["checksum"], before_head["obj"]["checksum"], "members never see new metadata with old bytes")
        self.cloud.check_blob_invariant()
        self.assertEqual(self.rows("SELECT sha256 FROM media_local WHERE handle = ?", handle), [(hashlib.sha256(old).hexdigest(),)],
                         "the sidecar still says the website holds the old bytes")
        doc = self.push()                                    # the next run converges
        self.assertEqual(self.cloud.blob_bytes(handle), new)
        self.assertEqual(self.cloud.blobs[handle]["sha256"], hashlib.sha256(new).hexdigest())
        self.cloud.check_blob_invariant()
        self.assertNotIn("media/.staging/%s/%s" % (handle, hashlib.sha256(new).hexdigest()), self.cloud.staging)
        self.assertEqual(self.rows("SELECT sha256 FROM media_local WHERE handle = ?", handle), [(hashlib.sha256(new).hexdigest(),)])

    def test_a_lost_answer_is_replayed_with_the_blob_claim_and_the_sidecar_learns_the_bytes(self):
        self.seed()
        data = jpeg("thirteen")
        handle = self.add_photo(data)
        self.cloud.lose_response = 1
        doc = self.push()
        self.assertEqual(doc["exit_code"], consts.EXIT_TEMPORARY)
        self.assertEqual(self.rows("SELECT COUNT(*) FROM media_local WHERE handle = ?", handle), [(0,)], "nothing is recorded before an acknowledgement")
        presigns = len(self.cloud.presigns)
        doc = self.push()
        self.assertEqual(self.cloud.blob_bytes(handle), data)
        self.assertEqual(len(self.cloud.presigns), presigns, "the replay needs no new upload")
        self.assertEqual(self.rows("SELECT sha256, origin FROM media_local WHERE handle = ?", handle), [(hashlib.sha256(data).hexdigest(), "up")])

    # ---- upload failures (D31) -----------------------------------------------------------------------------------------------------

    def test_an_upload_refused_once_is_asked_for_again_with_a_new_presign(self):
        self.seed()
        data = jpeg("fourteen")
        handle = self.add_photo(data)
        self.cloud.refuse_put = 1
        presigns = len(self.cloud.presigns)
        self.push()
        self.assertEqual(len(self.cloud.presigns), presigns + 2)
        self.assertEqual(self.cloud.blob_bytes(handle), data)

    def test_an_upload_refused_twice_defers_that_media_and_what_refers_to_it_to_the_next_run(self):
        self.seed()
        data = jpeg("fifteen")
        handle = self.add_photo(data, rect=[1, 2, 3, 4], person="I0002")
        person = self.tree.person_by_id("I0002")["handle"]
        version = self.cloud.heads[person]["version"]
        self.cloud.refuse_put = 2
        doc = self.push()
        self.assertEqual(doc["result"], "partial")
        self.assertNotIn(handle, self.cloud.heads, "the Media op was not sent without its bytes")
        self.assertEqual(self.cloud.heads[person]["version"], version, "and the person who refers to it waits")
        rules = {(h, r) for h, r, _p in self.rows("SELECT handle, rule, path FROM holds")}
        self.assertIn((handle, "media_upload_failed"), rules)
        self.assertIn((person, "media_dependency_deferred"), rules)
        doc = self.push()
        self.assertEqual(self.cloud.blob_bytes(handle), data)
        self.assertGreater(self.cloud.heads[person]["version"], version)
        self.assertEqual([r for r in self.rows("SELECT rule FROM holds WHERE rule LIKE 'media_upload%' OR rule = 'media_dependency_deferred'")], [])

    def test_a_staged_blob_the_website_cannot_find_is_uploaded_again_once(self):
        self.seed()
        data = jpeg("twenty")
        handle = self.add_photo(data)
        self.cloud.lose_staging = 1
        presigns = len(self.cloud.presigns)
        self.push()
        self.assertEqual(len(self.cloud.presigns), presigns + 2, "uploaded again")
        self.assertEqual(self.cloud.blob_bytes(handle), data)
        self.assertEqual(self.rows("SELECT state, COUNT(*) FROM outbox WHERE state = 'rejected' GROUP BY state"), [("rejected", 1)],
                         "the batch that could not find its blob is closed; the re-sent one is acked")

    def test_a_staged_blob_that_vanishes_twice_defers_that_media(self):
        self.seed()
        handle = self.add_photo(jpeg("twentyone"))
        self.cloud.lose_staging = 2
        doc = self.push()
        self.assertEqual(doc["result"], "partial")
        self.assertNotIn(handle, self.cloud.heads)
        self.assertIn((handle, "media_upload_failed", "/blob"), self.holds())
        self.push()
        self.assertEqual(self.cloud.blob_bytes(handle), jpeg("twentyone"))

    def test_a_presign_the_website_refuses_defers_the_media(self):
        self.seed()
        handle = self.add_photo(jpeg("sixteen"))
        self.cloud.refuse_presign = [(400, "validation")]
        self.push()
        self.assertNotIn(handle, self.cloud.heads)
        self.assertIn((handle, "media_upload_refused", "/blob"), self.holds())

    def test_a_file_that_changes_under_the_push_is_not_sent_with_the_wrong_checksum(self):
        self.seed()
        handle = self.add_photo(jpeg("seventeen"))
        path = self.file_of(self.tree.data[handle])
        real = mediaup.read_verified

        def swapped(info):
            with open(path, "wb") as fh:
                fh.write(jpeg("changed"))
            return real(info)
        with mock.patch.object(mediaup, "read_verified", swapped):
            self.push()
        self.assertNotIn(handle, self.cloud.heads)
        self.assertIn((handle, "media_file_changed", "/blob"), self.holds())
        self.push()
        self.assertEqual(self.cloud.blob_bytes(handle), jpeg("changed"))

    def test_a_blob_url_that_does_not_carry_the_signed_checksum_is_not_used(self):
        self.seed()
        handle = self.add_photo(jpeg("eighteen"))
        original = self.cloud._presign

        def lying(body):
            resp = original(body)
            resp.body["headers"]["x-amz-checksum-sha256"] = base64.b64encode(b"x" * 32).decode("ascii")
            return resp
        self.cloud._presign = lying
        self.push()
        self.assertEqual(self.cloud.puts and [p for p in self.cloud.puts if handle in p[0]], [])
        self.assertIn((handle, "media_upload_failed", "/blob"), self.holds())

    def test_a_download_url_with_credentials_or_plain_http_is_refused(self):
        class Client:
            def __init__(self, url):
                self.http = mock.Mock()
                self.url = url

            def post(self, path, body=None, idempotency_key=None):
                return mock.Mock(body={"upload_url": self.url, "headers": {"Content-Type": "image/jpeg", "x-amz-checksum-sha256": body["sha256_b64"]}})
        path = os.path.join(self.tmp, "f.jpg")
        data = jpeg("nineteen")
        with open(path, "wb") as fh:
            fh.write(data)
        info = mediafile.inspect(path)
        for url in ("http://blobs.example.org/x", "https://user:pw@blobs.example.org/x", "ftp://blobs.example.org/x"):
            c = Client(url)
            with self.assertRaises(mediaup.Deferred):
                mediaup.upload(c, "h" * 20, info)
            c.http.send.assert_not_called()

    # ---- rects --------------------------------------------------------------------------------------------------------------------

    def test_100_random_integer_rects_survive_push_then_pull_unchanged(self):
        self.seed()
        rng = random.Random(207)
        photo = self.media("O0001")["handle"]
        person = self.tree.person_by_id("I0002")["handle"]

        def rects(n):
            out = []
            while len(out) < n:
                x1, y1 = rng.randint(0, 99), rng.randint(0, 99)
                r = [x1, y1, rng.randint(x1 + 1, 100), rng.randint(y1 + 1, 100)]
                if r != [0, 0, 100, 100]:                    # Gramps normalises the full frame to null (BRD2 11.1)
                    out.append(r)
            return out

        def refs(rs):
            template = copy.deepcopy(self.tree.person_by_id("I0003")["media_list"][0])
            return [dict(copy.deepcopy(template), ref=photo, rect=r) for r in rs]

        pushed = rects(100)
        self.tree.edit(person, lambda p: p.update(media_list=refs(pushed)))
        self.assertEqual(self.push()["exit_code"] in (0, 20), True)
        got = [r["rect"] for r in self.cloud.heads[person]["obj"]["media_list"]]
        self.assertEqual(got, pushed, "push: the cloud holds the same four integers, in order")
        for r in got:
            self.assertTrue(all(type(v) is int for v in r))
        # a web tagger rewrites every rect; the pull brings them into the tree exactly
        tagged = rects(100)

        def retag(obj):
            for el, r in zip(obj["media_list"], tagged):
                el["rect"] = r
        self.cloud.edit(person, retag)
        self.assertEqual(self.pull()["exit_code"], 0)
        self.assertEqual([r["rect"] for r in self.tree.data[person]["media_list"]], tagged, "pull: the tree holds the same four integers")
        self.assertEqual(self.push()["counts"]["pushed"], {"create": 0, "update": 0, "delete": 0}, "and nothing is left to push")


if __name__ == "__main__":
    unittest.main()
