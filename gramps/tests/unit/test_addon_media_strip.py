"""A photo with a GPS position goes up as a copy without it (HFY-TSK-374): the setting, the upload, the bookkeeping, the pull and the command.

    cd gramps/tests/unit && python3 -m unittest test_addon_media_strip

The website is push_support.FakeCloud, as in test_addon_media_up.py. The photos are built from fabricated bytes and a fabricated position
(locstrip_support.py). Standard library only; no Gramps, no network. The byte-level behaviour of the strip itself is test_addon_locstrip.py.
"""
import copy
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import locstrip_support as LS  # noqa: E402
import push_support as PS  # noqa: E402
from test_addon_push import PushCase  # noqa: E402
from hfygramps.addon import consts, locstrip, mediafile, mediaup, paths  # noqa: E402

FIXTURE_MEDIA = os.path.join(PS.GRAMPS, "tests", "fixtures", "media")
JPEG = "image/jpeg"
NODE = shutil.which("node")


def sha(data):
    return hashlib.sha256(data).hexdigest()


class StripCase(PushCase):
    full = True
    tree_class = PS.MediaPushTree

    def setUp(self):
        PushCase.setUp(self)
        self.base = os.path.join(self.tmp, "media-base")
        shutil.copytree(FIXTURE_MEDIA, os.path.join(self.base, "media"))
        self.tree.media_base = self.base
        self.n_photo = 0

    def set_strip(self, on=True):
        cfg = paths.read_json(paths.config_path(self.env))
        cfg[consts.STRIP_LOCATION_KEY] = on
        paths.atomic_write_json(paths.config_path(self.env), cfg)

    def add_photo(self, data, gid="O0100", mime="image/jpeg", name=None):
        self.n_photo += 1
        name = name or "new/photo%d.jpg" % self.n_photo
        path = os.path.join(self.base, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)
        template = copy.deepcopy(self.tree.by_id("Media", "O0001"))
        handle = "e%026d" % self.n_photo
        template.update(handle=handle, gramps_id=gid, path=name, mime=mime, desc="A new synthetic photo", checksum=hashlib.md5(data).hexdigest(), private=False)
        self.tree.data[handle] = template
        owner = self.tree.person_by_id("I0002")
        ref = copy.deepcopy(owner["media_list"][0] if owner["media_list"] else self.tree.person_by_id("I0003")["media_list"][0])
        ref.update(ref=handle, rect=None, private=False)
        owner["media_list"] = owner["media_list"] + [ref]
        return handle, path

    def disk(self, path):
        with open(path, "rb") as fh:
            return fh.read()

    def holds(self):
        return {h: (r, d) for h, r, d in self.rows("SELECT handle, rule, detail FROM holds WHERE class = 'Media'")}

    def everything_written(self):
        """All the text this run left: the cloud's request bodies, status.json, the run logs, the previews."""
        tp = paths.TreePaths(self.tree.dbid, self.env)
        out = [self.cloud.log_text()]
        for folder in (tp.logs, tp.previews):
            for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
                with open(os.path.join(folder, name), "rb") as fh:
                    out.append(fh.read().decode("utf-8", "replace"))
        if os.path.exists(tp.status):
            out.append(open(tp.status, encoding="utf-8").read())
        return "\n".join(out)


class Setting(StripCase):
    def test_it_is_off_unless_config_json_says_true_for_this_tree(self):
        from hfygramps.addon import binding
        self.assertFalse(binding.strip_location_setting(None, "aa11bb22"))
        self.assertFalse(binding.strip_location_setting({"dbid": "aa11bb22"}, "aa11bb22"))
        for value in (False, "true", 1, "on", None, []):
            self.assertFalse(binding.strip_location_setting({"dbid": "aa11bb22", "strip_location": value}, "aa11bb22"), repr(value))
        self.assertFalse(binding.strip_location_setting({"dbid": "other", "strip_location": True}, "aa11bb22"), "another tree's setting is not this tree's")
        self.assertTrue(binding.strip_location_setting({"dbid": "aa11bb22", "strip_location": True}, "aa11bb22"))

    def test_with_the_setting_off_a_photo_with_a_position_is_held_as_it_always_was(self):
        self.seed()
        handle, path = self.add_photo(LS.jpeg(LS.build_tiff(), LS.xmp_packet()))
        before = self.disk(path)
        doc = self.push()
        self.assertNotIn(handle, self.cloud.heads)
        self.assertEqual(self.cloud.puts and [p for p in self.cloud.puts if handle in p[0]], [])
        rule, detail = self.holds()[handle]
        self.assertEqual(rule, "media.exif_gps.hold")
        self.assertIn("remove the location info, then sync", detail)
        self.assertEqual(doc["counts"]["media_location_stripped"], 0)
        self.assertEqual(self.disk(path), before)


class Upload(StripCase):
    def photo(self):
        self.seed()
        data = LS.jpeg(LS.build_tiff(), LS.xmp_packet())
        handle, path = self.add_photo(data)
        return data, handle, path

    def test_the_copy_goes_up_and_every_number_is_the_copy_s(self):
        data, handle, path = self.photo()
        obj_before = copy.deepcopy(self.tree.data[handle])
        self.set_strip(True)
        gps_before = len([h for h in self.holds().values() if h[0] == "media.exif_gps.hold"])
        doc = self.push()
        copy_bytes, why = locstrip.strip(data, JPEG)
        self.assertEqual(why, "")
        self.assertNotEqual(copy_bytes, data)
        key, headers, size = self.cloud.puts[-1]
        self.assertEqual(key, "media/.staging/%s/%s" % (handle, sha(copy_bytes)), "the staging key is the copy's SHA-256")
        self.assertEqual(size, len(copy_bytes))
        self.assertEqual(self.cloud.blob_bytes(handle), copy_bytes)
        blob = self.cloud.blobs[handle]
        self.assertEqual((blob["sha256"], blob["md5"], blob["size"]), (sha(copy_bytes), hashlib.md5(copy_bytes).hexdigest(), len(copy_bytes)))
        self.assertEqual(self.cloud.heads[handle]["obj"]["checksum"], hashlib.md5(copy_bytes).hexdigest(), "the Media checksum the website holds is the copy's")
        self.assertFalse(mediafile.exif_gps(self.cloud.blob_bytes(handle), JPEG))
        self.assertFalse(locstrip.has_location_residue(self.cloud.blob_bytes(handle), JPEG))
        self.cloud.check_blob_invariant()
        # nothing on this Mac changed
        self.assertEqual(self.disk(path), data, "the original file is byte for byte as it was")
        self.assertEqual(self.tree.data[handle], obj_before, "the Gramps Media object (path, checksum, everything) is untouched")
        # the picture data of the copy is the original's
        at = LS.scan_start(data)
        self.assertEqual(copy_bytes[copy_bytes.index(b"\xff\xda"):], data[at:], "the scan header, the compressed picture data and the end are the original's")
        self.assertLess(len(copy_bytes), len(data), "the copy has minimal metadata")
        # the count, and no hold for it
        self.assertEqual(doc["counts"]["media_location_stripped"], mediafile.stripped_count(self.tree.media_files()))
        self.assertGreaterEqual(doc["counts"]["media_location_stripped"], 1)
        self.assertNotIn(handle, self.holds())
        self.assertEqual(len([h for h in self.holds().values() if h[0] == "media.exif_gps.hold"]), 0, "none is held for its position any more")
        self.assertEqual(doc["counts"]["media_location_stripped"], gps_before + 1, "the fixture's own photo with a position goes the same way")

    def test_the_sidecar_remembers_local_sha_to_uploaded_sha_and_the_next_sync_sends_nothing(self):
        data, handle, path = self.photo()
        self.set_strip(True)
        self.push()
        copy_bytes = self.cloud.blob_bytes(handle)
        con = self.sidecar()
        try:
            self.assertEqual(mediaup.stripped_map(con)[handle], (sha(data), sha(copy_bytes), hashlib.md5(copy_bytes).hexdigest()))
        finally:
            con.close()
        self.assertEqual(self.rows("SELECT md5, sha256, size, origin FROM media_local WHERE handle = ?", handle),
                         [(hashlib.md5(copy_bytes).hexdigest(), sha(copy_bytes), len(copy_bytes), "up")])
        presigns, puts, ops = len(self.cloud.presigns), len(self.cloud.puts), len(self.cloud.pushed_ops())
        doc = self.push()
        self.assertEqual((doc["counts"]["media_up"], len(self.cloud.presigns), len(self.cloud.puts)), (0, presigns, puts))
        self.assertEqual(len(self.cloud.pushed_ops()), ops, "no op for it either")
        self.assertEqual(doc["counts"]["conflicts_open"], 0)
        self.assertGreaterEqual(doc["counts"]["media_location_stripped"], 1, "it is still reported: it is on the website without its location")
        self.assertEqual(self.rows("SELECT COUNT(*) FROM conflicts"), [(0,)])

    def test_no_coordinate_reaches_a_log_a_status_file_a_preview_or_the_website_s_requests(self):
        data, handle, path = self.photo()
        self.set_strip(True)
        self.push()
        self.push(dry_run=True)
        text = self.everything_written()
        for token in (b"33.4242", b"4.5151", b"37,33", b"122,4", b"GPSLatitude", b"1234/10"):
            self.assertNotIn(token.decode(), text)
        self.assertNotIn(self.base, text)

    def test_a_pull_never_writes_a_copy_over_the_original_or_moves_the_path(self):
        data, handle, path = self.photo()
        self.set_strip(True)
        self.push()
        obj_before = copy.deepcopy(self.tree.data[handle])
        with mock.patch.object(PS.PullView, "media_download", autospec=True) as download:
            doc = self.pull("pull")
            self.assertNotEqual(doc["result"], "failed", doc)
            # a change from the website to the same Media: the title
            self.cloud.edit(handle, lambda o: o.update(desc="Edited on the website"))
            doc = self.pull("pull")
            self.assertNotEqual(doc["result"], "failed", doc)
            self.assertEqual(download.call_count, 0, "the copy is the website's file for this Media: nothing is downloaded")
        self.assertEqual(self.disk(path), data)
        now = self.tree.data[handle]
        self.assertEqual((now["path"], now["checksum"]), (obj_before["path"], obj_before["checksum"]), "Media.path and Media.checksum stay the original's")
        self.assertEqual(now["desc"], "Edited on the website", "the title did come over: the pull ran")
        self.assertEqual(doc["counts"]["media_down"], 0)
        self.assertEqual(self.push()["counts"]["media_up"], 0)

    def test_a_new_edit_to_the_file_sends_the_new_copy_and_a_clean_file_replaces_it(self):
        data, handle, path = self.photo()
        self.set_strip(True)
        self.push()
        first = self.cloud.blob_bytes(handle)
        newer = LS.jpeg(LS.build_tiff(">"), None, body=LS.BASELINE2)
        with open(path, "wb") as fh:
            fh.write(newer)
        self.push()
        second = self.cloud.blob_bytes(handle)
        self.assertEqual(second, locstrip.strip(newer, JPEG)[0])
        self.assertNotEqual(first, second)
        clean = LS.jpeg(LS.build_tiff(gps=False), body=LS.GRAY)
        with open(path, "wb") as fh:
            fh.write(clean)
        self.push()
        self.assertEqual(self.cloud.blob_bytes(handle), clean, "a file with no position goes as it is")
        self.assertEqual(self.disk(path), clean)

    def test_the_original_changing_between_the_plan_and_the_upload_sends_nothing(self):
        data, handle, path = self.photo()
        self.set_strip(True)
        info = mediafile.inspect(path, strip_location=True)
        self.assertTrue(info["location_stripped"])
        self.assertEqual(mediaup.read_verified(info), locstrip.strip(data, JPEG)[0])
        with open(path, "wb") as fh:
            fh.write(data + b"x")
        with self.assertRaises(mediaup.Deferred) as ctx:
            mediaup.read_verified(info)
        self.assertEqual(ctx.exception.rule, "media_file_changed")
        with open(path, "wb") as fh:
            fh.write(data)
        with mock.patch.object(mediafile, "strip_copy", return_value=(None, "verify_failed")):
            with self.assertRaises(mediaup.Deferred) as ctx:
                mediaup.read_verified(info)
        self.assertEqual(ctx.exception.rule, "media_location_not_removed")


class StaysHeld(StripCase):
    def test_a_tiff_a_corrupt_file_and_a_png_with_raw_profile_text_stay_held_with_a_clear_message(self):
        self.seed()
        tiff, tiff_path = self.add_photo(LS.build_tiff(), gid="O0101", mime="image/tiff", name="new/a.tif")
        broken_jpeg = LS.jpeg(LS.build_tiff())
        broken, broken_path = self.add_photo(broken_jpeg[:LS.scan_start(broken_jpeg) - 30], gid="O0102", name="new/broken.jpg")
        self.set_strip(True)
        before = {p: self.disk(p) for p in (tiff_path, broken_path)}
        doc = self.push()
        for handle in (tiff, broken):
            self.assertNotIn(handle, self.cloud.heads)
            self.assertEqual(self.holds()[handle][0], "media.exif_gps.hold")
        self.assertEqual(mediafile.inspect(tiff_path, strip_location=True)["strip_refused"], "tiff")
        self.assertIn("TIFF", self.holds()[tiff][1])
        self.assertIn("could not make a copy", self.holds()[broken][1])
        self.assertEqual(doc["counts"]["media_location_stripped"], mediafile.stripped_count(self.tree.media_files()))
        for p, b in before.items():
            self.assertEqual(self.disk(p), b)

    def test_with_the_setting_off_the_info_of_a_photo_is_what_it_always_was(self):
        data = LS.jpeg(LS.build_tiff())
        d = tempfile.mkdtemp(prefix="hfy-strip-")
        self.addCleanup(shutil.rmtree, d, True)
        path = os.path.join(d, "a.jpg")
        open(path, "wb").write(data)
        off, on = mediafile.inspect(path), mediafile.inspect(path, strip_location=True)
        self.assertEqual((off["state"], off["exif_gps"], off["sha256"], "location_stripped" in off), ("gps", True, sha(data), False))
        self.assertEqual((on["state"], on["exif_gps"], on["location_stripped"], on["local_sha256"]), ("ok", False, True, sha(data)))
        self.assertEqual(on["size"], len(locstrip.strip(data, JPEG)[0]))
        clean = LS.jpeg(LS.build_tiff(gps=False))
        open(path, "wb").write(clean)
        self.assertEqual(mediafile.inspect(path, strip_location=True), dict(mediafile.inspect(path), path=path))
        self.assertNotIn("location_stripped", mediafile.inspect(path, strip_location=True))

    def test_the_download_check_still_holds_a_photo_with_a_position_that_arrives_from_the_website(self):
        data = LS.jpeg(LS.build_tiff())
        self.assertEqual(mediafile.hold_for_bytes(data), mediafile.GPS_RULE)
        self.assertEqual(consts.DOWNLOAD_HOLD_RULES[0], "media.exif_gps.hold")


class BlobChanged(unittest.TestCase):
    """plan._blob_changed: the sidecar's record of an uploaded copy is a witness that holds whatever the file or the setting is now."""

    def test_the_witnesses(self):
        from hfygramps.addon import plan
        cloud, local = {"checksum": "a" * 32}, {"checksum": "b" * 32}
        self.assertTrue(plan._blob_changed(local, cloud), "another file on the website is a change")
        self.assertFalse(plan._blob_changed(local, cloud, None, ("x", "y", "a" * 32)), "the sidecar says that checksum is a copy this desktop sent")
        self.assertTrue(plan._blob_changed(local, cloud, None, ("x", "y", "c" * 32)), "but not another one")
        self.assertTrue(plan._blob_changed(local, cloud, None, ("x", "y")), "an older record has no checksum: the held-back layer applies")
        self.assertFalse(plan._blob_changed(local, cloud, {"location_stripped": True, "md5": "a" * 32}), "the copy of the file as it is now")
        self.assertFalse(plan._blob_changed(local, {"checksum": ""}), "no checksum on the website: nothing to download")


class DLView(PS.PullView):
    """A pull view that really serves the website's blob, and records every download."""

    calls = []

    def media_download(self, handle):
        data = self.cloud.blob_bytes(handle)
        DLView.calls.append(handle)
        blob = self.cloud.blobs[handle]
        url = "https://blob.invalid/%s" % handle
        self.cloud.snapshot_files[url] = data
        return {"url": url, "sha256": blob["sha256"], "md5": blob["md5"], "size": blob["size"], "content_type": blob["content_type"]}


class PullNeverRepoints(StripCase):
    """A review found that a pull downloaded the copy and pointed Media.path at it once the setting was off, the original was missing or
    online-only, or the strip refused: the sidecar's record of what was uploaded now says the website's file is ours, whatever the file is."""

    def setUp(self):
        StripCase.setUp(self)
        cfg = paths.read_json(paths.config_path(self.env))
        cfg["media_root"] = os.path.join(self.tmp, "mroot")
        paths.atomic_write_json(paths.config_path(self.env), cfg)
        DLView.calls = []

    def dlpull(self):
        from hfygramps.addon import runner
        self.n += 1
        return runner.run(self.tree, "cli", runner.Options("pull", yes=True), run_id="r%02d" % self.n, argv=["gramps"], environ=self.env,
                          services={"cloud": DLView(self.cloud)})

    def scenario(self, after_push, website_edit=None):
        self.seed()
        data = LS.jpeg(LS.build_tiff(), LS.xmp_packet())
        handle, path = self.add_photo(data)
        self.set_strip(True)
        self.push()
        before = copy.deepcopy(self.tree.data[handle])
        after_push(handle, path)
        self.cloud.edit(handle, website_edit or (lambda o: o.update(desc="Edited on the website")))
        doc = self.dlpull()
        now = self.tree.data[handle]
        self.assertNotEqual(doc["result"], "failed", doc)
        self.assertEqual(DLView.calls, [], "nothing is downloaded")
        self.assertEqual((now["path"], now["checksum"]), (before["path"], before["checksum"]), "Media.path and Media.checksum are the original's")
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "mroot")) and os.listdir(os.path.join(self.tmp, "mroot")), "nothing was written to the media folder")
        if os.path.exists(path):
            self.assertEqual(self.disk(path), data)
        return now, doc

    def test_control_the_setting_stays_on(self):
        now, _doc = self.scenario(lambda h, p: None)
        self.assertEqual(now["desc"], "Edited on the website", "the website's other changes do come over")

    def test_the_setting_was_turned_off(self):
        now, _doc = self.scenario(lambda h, p: self.set_strip(False))
        self.assertEqual(now["desc"], "Edited on the website")

    def test_the_original_was_moved_away(self):
        self.scenario(lambda h, p: os.rename(p, p + ".moved"))

    def test_the_original_is_a_dropbox_online_only_file(self):
        def placeholder(handle, path):
            original = mediafile.xattr_names
            mediafile.xattr_names = lambda p, _o=original, _path=path: [mediafile.PLACEHOLDER_XATTR] if p == _path else _o(p)
            self.addCleanup(setattr, mediafile, "xattr_names", original)
        self.scenario(placeholder)

    def test_the_strip_refuses_the_file_today(self):
        def refuse(handle, path):
            patch = mock.patch.object(mediafile, "strip_copy", return_value=(None, "verify_failed"))
            patch.start()
            self.addCleanup(patch.stop)
        self.scenario(refuse)

    def test_another_file_on_the_website_is_held_not_downloaded(self):
        now, doc = self.scenario(lambda h, p: None, website_edit=lambda o: o.update(checksum="e" * 32))
        self.assertGreaterEqual(doc["counts"]["holds"], 1, "the replaced file is listed as held back")


class CountsFollowTheWebsite(StripCase):
    """counts.media_location_stripped is what the website holds: a copy counts after its upload is acknowledged, never while it is deferred."""

    def test_a_deferred_upload_is_pending_not_counted_and_not_remembered(self):
        self.seed()
        data = LS.jpeg(LS.build_tiff(), LS.xmp_packet())
        handle, _path = self.add_photo(data)
        self.set_strip(True)
        with mock.patch.object(mediaup, "upload", side_effect=mediaup.Deferred("media_upload_failed")):
            doc = self.push()
        wanted = mediafile.stripped_count(self.tree.media_files())
        self.assertEqual((doc["counts"]["media_location_stripped"], doc["counts"]["media_location_stripped_pending"]), (0, wanted))
        con = self.sidecar()
        try:
            self.assertEqual(mediaup.stripped_map(con), {})
        finally:
            con.close()
        look = self.push(dry_run=True)
        self.assertEqual((look["counts"]["media_location_stripped"], look["counts"]["media_location_stripped_pending"]), (0, wanted))
        done = self.push()
        self.assertEqual((done["counts"]["media_location_stripped"], done["counts"]["media_location_stripped_pending"]), (wanted, 0))
        again = self.push(dry_run=True)
        self.assertEqual((again["counts"]["media_location_stripped"], again["counts"]["media_location_stripped_pending"]), (wanted, 0))
        self.assertIn(handle, self.stripped_handles())

    def stripped_handles(self):
        con = self.sidecar()
        try:
            return set(mediaup.stripped_map(con))
        finally:
            con.close()


class DetectorInThePush(StripCase):
    """A photo whose position sits only where the older detector did not look (the Exif sub-IFD) is held with the setting off and stripped with it on."""

    def photo(self):
        self.seed()
        tiff = LS.assemble("<", [("ifd0", [LS.asc("<", 0x010F, LS.MAKE), LS.ref(0x8769, "ifd", "exif")], None),
                                 ("exif", [(0x9003, 2, len(LS.DATE) + 1, LS.DATE + b"\x00"), LS.ref(0x8825, "ifd", "gps")], None),
                                 ("gps", LS.gps_entries("<"), None)], {})
        return self.add_photo(LS.jpeg(tiff))

    def test_it_is_held_with_the_setting_off_with_the_same_message(self):
        handle, _path = self.photo()
        self.push()
        rule, detail = self.holds()[handle]
        self.assertEqual(rule, "media.exif_gps.hold")
        self.assertIn("remove the location info, then sync", detail)
        self.assertNotIn(handle, self.cloud.heads)

    def test_it_is_stripped_with_the_setting_on(self):
        handle, path = self.photo()
        original = self.disk(path)
        self.set_strip(True)
        self.push()
        self.assertIn(handle, self.cloud.heads)
        self.assertFalse(mediafile.exif_gps(self.cloud.blob_bytes(handle), JPEG))
        self.assertEqual(self.disk(path), original)


class ScanHolds(StripCase):
    """A photo held because its metadata cannot be read, or is too much to check, says that: its own rule and words, not "remove the location"."""

    def test_unreadable_and_over_the_limit_have_their_own_rules_with_the_setting_off_and_on(self):
        import test_addon_locstrip_leaks as LK
        self.seed()
        lying, _p1 = self.add_photo(LS.jpeg(LK.lying(LS.build_tiff("<", gps=False), 300)), gid="O0111", name="new/lying.jpg")
        heavy, _p2 = self.add_photo(LS.jpeg(None, extra_segments=LS.segment(0xFE, LK.quad_segment(250)) * 2), gid="O0112", name="new/heavy.jpg")
        for on in (False, True):
            self.set_strip(on)
            doc = self.push()
            held = self.holds()
            self.assertEqual((held[lying][0], held[heavy][0]), ("media_scan_unreadable", "media_scan_limit"), on)
            for handle in (lying, heavy):
                self.assertIn("not known to have one", held[handle][1])
                self.assertNotIn("remove the location", held[handle][1])
                self.assertNotIn(handle, self.cloud.heads)
            self.assertEqual(doc["counts"]["media_location_stripped"], mediafile.stripped_count(self.tree.media_files()) if on else 0)

    def test_a_photo_with_a_position_the_strip_cannot_rebuild_keeps_the_location_words(self):
        import test_addon_locstrip_leaks as LK
        self.seed()
        handle, _path = self.add_photo(LS.jpeg(LK.lying(LS.build_tiff("<"), 300)), gid="O0113", name="new/lying-gps.jpg")
        self.set_strip(True)
        self.push()
        rule, detail = self.holds()[handle]
        self.assertEqual(rule, "media.exif_gps.hold")
        self.assertIn("could not make a copy", detail)


class PhoneStyleCopies(StripCase):
    """The two real-world-shaped samples go up as minimal copies that keep their Orientation and their colour profile."""

    def test_a_phone_style_jpeg_and_a_png_keep_orientation_and_icc_and_nothing_else(self):
        self.seed()
        profile = LS.icc_profile()
        jpg = LS.jpeg(LS.build_tiff(">"), LS.xmp_packet(), extra_segments=LS.icc_segments(profile) + LS.segment(0xFE, b"a comment") + LS.segment(0xED, b"Photoshop 3.0\x00" + b"x" * 20))
        png = LS.png(tiff=LS.build_tiff("<"), xmp=LS.xmp_packet(), compress_xmp=True, icc=profile, text=b"Comment\x00hello")
        hj, pj = self.add_photo(jpg, gid="O0130", name="new/phone.jpg")
        hp, pp = self.add_photo(png, gid="O0131", mime="image/png", name="new/phone.png")
        self.set_strip(True)
        self.push()
        out_j, out_p = self.cloud.blob_bytes(hj), self.cloud.blob_bytes(hp)
        self.assertEqual(locstrip._icc_of_jpeg(locstrip._jpeg_parts(out_j)), locstrip._rewrite_icc(profile))
        self.assertEqual(dict(locstrip._jpeg_parts(out_j))[0xE1], b"Exif\x00\x00" + locstrip._exif_tiff(">", 6))
        kinds = dict((k, b) for k, b, _c in locstrip._chunks(out_p))
        self.assertEqual(kinds[b"eXIf"], locstrip._exif_tiff("<", 6))
        self.assertIn(b"iCCP", kinds)
        for out in (out_j, out_p):
            self.assertFalse(mediafile.exif_gps(out, JPEG if out is out_j else "image/png"))
            for dropped in (b"xmpmeta", b"a comment", b"Photoshop", b"hello", b"SYNTHCAM"):
                self.assertNotIn(dropped, out)
        self.assertEqual((self.disk(pj), self.disk(pp)), (jpg, png), "the originals are untouched")

    def test_a_colour_profile_with_a_position_is_sent_with_fixed_words(self):
        self.seed()
        handle, _path = self.add_photo(LS.jpeg(LS.build_tiff(), extra_segments=LS.icc_segments(LS.icc_profile(desc="Shot at 12.3456, 65.4321"))), gid="O0132", name="new/icc.jpg")
        self.set_strip(True)
        self.push()
        self.assertNotIn(handle, self.holds())
        out = self.cloud.blob_bytes(handle)
        self.assertNotIn(b"65.4321", out)
        self.assertNotIn("65.4321".encode("utf-16-be"), out)
        self.assertIn("Profile".encode("utf-16-be"), out)

    def test_a_colour_profile_the_add_on_cannot_follow_holds_the_photo_with_its_own_rule(self):
        self.seed()
        profile = LS.icc_profile(extra_tag=(b"zzzz", b"data\x00\x00\x00\x00" + b"x" * 12))
        handle, _path = self.add_photo(LS.jpeg(LS.build_tiff(), extra_segments=LS.icc_segments(profile)), gid="O0133", name="new/icc2.jpg")
        self.set_strip(True)
        self.push()
        rule, detail = self.holds()[handle]
        self.assertEqual(rule, "media_icc_text")
        self.assertIn("colour profile", detail)
        self.assertNotIn(handle, self.cloud.heads)


class StrippedCommand(StripCase):
    """`hfy-sync stripped`: the way out of a photo the pull keeps listing as held back."""

    def setUp(self):
        StripCase.setUp(self)
        root = paths.gramps_data_root(self.env)
        os.makedirs(os.path.join(root, "grampsdb", self.tree.dbid), exist_ok=True)
        with open(os.path.join(root, "grampsdb", self.tree.dbid, "name.txt"), "w", encoding="utf-8") as fh:
            fh.write(self.tree.name)
        loader = importlib.machinery.SourceFileLoader("hfy_sync_cli2", os.path.join(PS.GRAMPS, "bin", "hfy-sync"))
        spec = importlib.util.spec_from_loader("hfy_sync_cli2", loader)
        self.cli = importlib.util.module_from_spec(spec)
        loader.exec_module(self.cli)
        cfg = paths.read_json(paths.config_path(self.env))
        cfg["media_root"] = os.path.join(self.tmp, "mroot")
        paths.atomic_write_json(paths.config_path(self.env), cfg)
        self.seed()
        self.handle, self.path = self.add_photo(LS.jpeg(LS.build_tiff(), LS.xmp_packet()), gid="O0120")
        self.set_strip(True)
        self.push()
        self.original = self.disk(self.path)

    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, self.env), redirect_stdout(out), redirect_stderr(err):
            code = self.cli.main(["stripped", "--tree", self.tree.name] + list(args))
        return code, out.getvalue(), err.getvalue()

    def recorded(self):
        con = self.sidecar()
        try:
            return set(mediaup.stripped_map(con))
        finally:
            con.close()

    def test_it_counts_and_prints_no_id(self):
        code, out, _err = self.run_cli()
        self.assertEqual(code, 0)
        self.assertIn("photo(s) recorded as sent without their location", out)
        self.assertNotIn(self.handle, out)

    def test_accept_the_website_file_is_a_look_without_yes_and_then_the_pull_takes_it(self):
        self.cloud.edit(self.handle, lambda o: o.update(checksum="e" * 32))
        DLView.calls = []
        from hfygramps.addon import runner
        def pull():
            self.n += 1
            return runner.run(self.tree, "cli", runner.Options("pull", yes=True), run_id="r%02d" % self.n, argv=["gramps"], environ=self.env,
                              services={"cloud": DLView(self.cloud)})
        pull()
        self.assertEqual(DLView.calls, [], "held back while the record stands")
        code, out, _err = self.run_cli("--accept-website-file", "O0120")
        self.assertEqual((code, self.handle in self.recorded()), (consts.EXIT_DRY_RUN_CHANGES, True))
        self.assertIn("would forget", out)
        code, out, _err = self.run_cli("--accept-website-file", "O0120", "--yes")
        self.assertEqual((code, self.handle in self.recorded()), (0, False))
        pull()
        self.assertEqual(DLView.calls, [self.handle], "now the website's file is the one the pull takes")
        self.assertEqual(self.disk(self.path), self.original, "the original file itself is still untouched")

    def test_accepting_a_website_file_that_is_still_your_copy_does_nothing_and_the_pull_never_re_points(self):
        DLView.calls = []
        from hfygramps.addon import runner
        before = {h: tuple(v) for h, v in self.recorded_map().items()}
        code, out, _err = self.run_cli("--accept-website-file", "O0120", "--yes")
        self.assertEqual(code, 0)
        self.assertIn("still your copy", out)
        self.assertEqual({h: tuple(v) for h, v in self.recorded_map().items()}, before, "the record is kept")
        self.set_strip(False)
        self.cloud.edit(self.handle, lambda o: o.update(desc="Edited on the website"))
        obj = copy.deepcopy(self.tree.data[self.handle])
        self.n += 1
        runner.run(self.tree, "cli", runner.Options("pull", yes=True), run_id="r%02d" % self.n, argv=["gramps"], environ=self.env, services={"cloud": DLView(self.cloud)})
        self.assertEqual(DLView.calls, [])
        now = self.tree.data[self.handle]
        self.assertEqual((now["path"], now["checksum"], now["desc"]), (obj["path"], obj["checksum"], "Edited on the website"))
        self.assertEqual(self.disk(self.path), self.original)

    def recorded_map(self):
        con = self.sidecar()
        try:
            return mediaup.stripped_map(con)
        finally:
            con.close()

    def test_a_damaged_or_hostile_sidecar_record_is_read_as_not_there(self):
        from hfygramps.addon import sidecar
        con = self.sidecar()
        try:
            for value in ("[" * 200000 + "]" * 200000, '{"a":' * 100000 + "1" + "}" * 100000, "not json"):
                con.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('media_location_stripped', ?)", (value,))
                self.assertEqual(sidecar.meta_json(con, "media_location_stripped", {}), {})
                self.assertEqual(mediaup.stripped_map(con), {})
        finally:
            con.close()

    def test_send_again_forgets_that_the_website_holds_the_copy_and_the_next_push_uploads_it(self):
        puts = len(self.cloud.puts)
        code, _out, _err = self.run_cli("--send-again", "O0120")
        self.assertEqual((code, len(self.rows("SELECT 1 FROM media_local WHERE handle = ?", self.handle))), (consts.EXIT_DRY_RUN_CHANGES, 1))
        code, _out, _err = self.run_cli("--send-again", "O0120", "--yes")
        self.assertEqual((code, self.rows("SELECT 1 FROM media_local WHERE handle = ?", self.handle)), (0, []))
        self.push()
        self.assertGreater(len(self.cloud.puts), puts, "the copy is uploaded again")
        self.assertEqual(self.disk(self.path), self.original)

    def test_bad_input_and_a_running_sync(self):
        self.assertEqual(self.run_cli("--accept-website-file", "O0120", "--send-again", "O0120")[0], consts.EXIT_USAGE)
        self.assertEqual(self.run_cli("--accept-website-file")[0], consts.EXIT_USAGE)
        self.assertEqual(self.run_cli("--accept-website-file", "NOPE", "--yes")[0], consts.EXIT_CONFIG)
        from hfygramps.addon import preflight
        tp = paths.TreePaths(self.tree.dbid, self.env)
        with preflight.StateLock(tp.lock) as lock:
            self.assertTrue(lock.acquired)
            self.assertEqual(self.run_cli("--accept-website-file", "O0120", "--yes")[0], consts.EXIT_TEMPORARY)
        self.assertIn(self.handle, self.recorded())

    def test_the_held_back_words_name_the_way_out(self):
        text = consts.HOLD_MESSAGES["media_stripped_replaced"]
        self.assertIn("hfy-sync stripped --accept-website-file", text)
        self.assertIn("--send-again", text)
        self.assertIn("every sync", text)


@unittest.skipIf(NODE is None, "node is not installed")
class TheWebsiteAgrees(unittest.TestCase):
    """api/src/upload-guard.js findLocation, the website's own detector, run on the copies (its S3 and HTTP imports are replaced by stubs
    so no dependency is installed): it finds a position in the originals and none in the copies. The sync routes (api/src/sync/media.js) check
    the staged object's size, SHA-256 and content type only, and the renderer takes a Media's checksum and size from the stored object."""

    def findings(self, blobs):
        src = open(os.path.join(PS.GRAMPS, "..", "api", "src", "upload-guard.js"), encoding="utf-8").read()
        lines = [ln for ln in src.splitlines() if not ln.startswith("import ") or "node:zlib" in ln]
        script = "class HttpError extends Error {}\nclass GetObjectCommand {}\nclass HeadObjectCommand {}\nclass S3Client {}\n" + "\n".join(lines)
        script += "\nconst fs = await import('node:fs');\nconst files = JSON.parse(process.argv[2]);\n" \
                  "console.log(JSON.stringify(files.map((f) => findLocation(fs.readFileSync(f)))));\n"
        d = tempfile.mkdtemp(prefix="hfy-guard-")
        self.addCleanup(shutil.rmtree, d, True)
        guard = os.path.join(d, "guard.mjs")
        open(guard, "w", encoding="utf-8").write(script)
        names = []
        for i, b in enumerate(blobs):
            names.append(os.path.join(d, "f%d" % i))
            open(names[-1], "wb").write(b)
        out = subprocess.run([NODE, guard, json.dumps(names)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, check=False)
        self.assertEqual(out.returncode, 0, out.stderr[-300:])
        return json.loads(out.stdout)

    def test_the_website_finds_a_position_in_the_originals_and_none_in_the_copies(self):
        originals = [(LS.jpeg(LS.build_tiff("<"), LS.xmp_packet()), JPEG), (LS.jpeg(LS.build_tiff(">"), None), JPEG),
                     (LS.jpeg(None, LS.xmp_packet(style="element")), JPEG), (LS.png(LS.build_tiff(), LS.xmp_packet(), True), "image/png"),
                     (LS.jpeg(LS.build_tiff(gps=False, thumb=LS.jpeg(LS.build_tiff())), None), JPEG)]
        copies = [locstrip.strip(b, ct)[0] for b, ct in originals]
        self.assertNotIn(None, copies)
        self.assertEqual(self.findings([b for b, _ in originals]), ["exif_gps", "exif_gps", "xmp_location", "exif_gps", "exif_gps"])
        self.assertEqual(self.findings(copies), [None] * 5)


class SettingsCommand(StripCase):
    """`hfy-sync settings`: reads config.json, never opens Gramps, changes the file only with --yes."""

    def setUp(self):
        StripCase.setUp(self)
        root = paths.gramps_data_root(self.env)
        os.makedirs(os.path.join(root, "grampsdb", self.tree.dbid), exist_ok=True)
        with open(os.path.join(root, "grampsdb", self.tree.dbid, "name.txt"), "w", encoding="utf-8") as fh:
            fh.write(self.tree.name)
        loader = importlib.machinery.SourceFileLoader("hfy_sync_cli", os.path.join(PS.GRAMPS, "bin", "hfy-sync"))
        spec = importlib.util.spec_from_loader("hfy_sync_cli", loader)
        self.cli = importlib.util.module_from_spec(spec)
        loader.exec_module(self.cli)

    def settings(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, self.env), redirect_stdout(out), redirect_stderr(err):
            code = self.cli.main(["settings", "--tree", self.tree.name] + list(args))
        return code, out.getvalue(), err.getvalue()

    def value(self):
        return paths.read_json(paths.config_path(self.env)).get(consts.STRIP_LOCATION_KEY)

    def test_it_shows_the_value_looks_by_default_and_changes_it_with_yes(self):
        before = paths.read_json(paths.config_path(self.env))
        self.assertEqual(self.settings()[:2], (0, "hfy-sync settings: strip_location off\n"))
        code, out, _err = self.settings("--strip-location", "on")
        self.assertEqual((code, self.value()), (consts.EXIT_DRY_RUN_CHANGES, None), "without --yes it only says what it would do")
        self.assertIn("would change", out)
        code, out, _err = self.settings("--strip-location", "on", "--yes")
        self.assertEqual((code, self.value(), out), (0, True, "hfy-sync settings: strip_location on (changed)\n"))
        after = dict(paths.read_json(paths.config_path(self.env)))
        after.pop(consts.STRIP_LOCATION_KEY)
        self.assertEqual(after, before, "every other key of config.json is kept")
        self.assertEqual(self.settings()[:2], (0, "hfy-sync settings: strip_location on\n"))
        self.assertEqual(self.settings("--strip-location", "on", "--yes")[0], 0, "already on: nothing to do")
        self.assertEqual(self.settings("--strip-location", "off", "--yes")[:2], (0, "hfy-sync settings: strip_location off (changed)\n"))
        self.assertIs(self.value(), False)

    def test_it_refuses_bad_values_an_unbound_tree_and_a_running_sync(self):
        self.assertEqual(self.settings("--strip-location", "maybe")[0], consts.EXIT_USAGE)
        self.assertEqual(self.settings("--strip-location")[0], consts.EXIT_USAGE)
        self.assertEqual(self.settings("--frobnicate")[0], consts.EXIT_USAGE)
        from hfygramps.addon import preflight
        tp = paths.TreePaths(self.tree.dbid, self.env)
        with preflight.StateLock(tp.lock) as lock:
            self.assertTrue(lock.acquired)
            self.assertEqual(self.settings("--strip-location", "on", "--yes")[0], consts.EXIT_TEMPORARY)
        self.assertIsNone(self.value())
        os.unlink(paths.config_path(self.env))
        self.assertEqual(self.settings("--strip-location", "on", "--yes")[0], consts.EXIT_CONFIG)

    def test_the_setting_is_never_in_anything_sent_to_the_website(self):
        self.seed()
        self.set_strip(True)
        self.push()
        self.assertNotIn(consts.STRIP_LOCATION_KEY, self.cloud.log_text())


if __name__ == "__main__":
    unittest.main()
