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
        self.assertEqual(copy_bytes[at:], data[at:])
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
            self.assertEqual(mediaup.stripped_map(con)[handle], (sha(data), sha(copy_bytes)))
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
        for token in (b"4242", b"5151", b"37,33", b"122,4", b"GPSLatitude", b"1234/10"):
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
        newer = LS.jpeg(LS.build_tiff(">"), None, scan=LS.SCAN[::-1])
        with open(path, "wb") as fh:
            fh.write(newer)
        self.push()
        second = self.cloud.blob_bytes(handle)
        self.assertEqual(second, locstrip.strip(newer, JPEG)[0])
        self.assertNotEqual(first, second)
        clean = LS.jpeg(LS.build_tiff(gps=False), scan=LS.SCAN[::-1] + b"clean")
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
        self.assertIn("could not remove it", self.holds()[broken][1])
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
