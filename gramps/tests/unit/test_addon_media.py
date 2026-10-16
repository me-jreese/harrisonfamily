"""Media files down in a pull (HFY-TSK-205; sync.md 8.3 step 6, section 9). Fake cloud, fake tree, synthetic bytes only."""
import copy
import hashlib
import os
import unittest

import addon_pull_support as S
from hfygramps.addon import consts, faults, media, transport

from test_addon_pull import by_gid, load_cloud_objs
from test_addon_pull_safety import fault

JPEG = b"\xff\xd8\xff\xe0synthetic-bytes-one\xff\xd9"
JPEG2 = b"\xff\xd8\xff\xe0synthetic-bytes-two\xff\xd9"


def new_media(env, handle="f" * 28, gid="O8001", blob=JPEG):
    m = copy.deepcopy(by_gid(load_cloud_objs(env), "O0001"))
    m.update(handle=handle, gramps_id=gid, checksum=hashlib.md5(blob).hexdigest(), desc="A website photo (fictional)")
    m["mime"] = "image/jpeg"
    return m


class MediaDown(S.PullCase):
    def media_root(self):
        return os.path.join(self.env.root, "media")

    def test_a_website_media_object_is_downloaded_verified_and_pointed_at(self):
        e = self.env
        m = new_media(e)
        e.cloud.blobs[m["handle"]] = {"bytes": JPEG, "content_type": "image/jpeg"}
        e.cloud.put(m)
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc["error"])
        path = os.path.join(self.media_root(), m["handle"] + ".jpg")
        with open(path, "rb") as fh:
            self.assertEqual(fh.read(), JPEG)
        self.assertEqual(e.tree.objects()[m["handle"]]["path"], path)
        self.assertEqual(doc["counts"]["media_down"], 1)
        con = e.side()
        try:
            row = con.execute("SELECT path, md5, sha256, size, origin FROM media_local WHERE handle = ?", (m["handle"],)).fetchone()
        finally:
            con.close()
        self.assertEqual(row, (path, hashlib.md5(JPEG).hexdigest(), hashlib.sha256(JPEG).hexdigest(), len(JPEG), "cloud"))
        # the path is a local-only field: the cloud object still has none, so the next check has nothing to push
        self.assertEqual(e.run("check")["exit_code"], 0)

    def test_a_check_downloads_nothing_but_says_what_it_would(self):
        e = self.env
        m = new_media(e)
        e.cloud.blobs[m["handle"]] = {"bytes": JPEG, "content_type": "image/jpeg"}
        e.cloud.put(m)
        doc = e.run("check")
        self.assertEqual(e.preview(doc)["media_to_download"], [m["handle"]])
        self.assertFalse(os.path.exists(self.media_root()))
        self.assertFalse([c for c in e.cloud.calls if c.startswith("media:")])

    def test_a_changed_blob_of_an_existing_media_object_is_downloaded_and_the_path_repointed(self):
        e = self.env
        orig = by_gid(load_cloud_objs(e), "O0001")
        site = copy.deepcopy(orig)
        site["checksum"] = hashlib.md5(JPEG2).hexdigest()
        e.cloud.blobs[orig["handle"]] = {"bytes": JPEG2, "content_type": "image/jpeg"}
        e.cloud.put(site)
        doc = e.run("pull", yes=True)
        self.assertEqual(doc["counts"]["media_down"], 1)
        self.assertEqual(e.tree.objects()[orig["handle"]]["path"], os.path.join(self.media_root(), orig["handle"] + ".jpg"))
        self.assertEqual(e.tree.objects()[orig["handle"]]["checksum"], site["checksum"])

    def test_a_file_that_does_not_match_its_checksums_is_never_written_and_defers_the_object_and_what_refers_to_it(self):
        e = self.env
        m = new_media(e)
        e.cloud.blobs[m["handle"]] = {"bytes": JPEG, "content_type": "image/jpeg", "sha256": "0" * 64}
        e.cloud.put(m)
        person = copy.deepcopy(by_gid(load_cloud_objs(e), "I0014"))
        person["media_list"] = person["media_list"] + [dict(person["media_list"][0], ref=m["handle"])]
        e.cloud.put(person)
        before = e.tree.objects()
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("partial", 20))
        self.assertEqual(e.tree.objects(), before, "neither the media object nor the person that refers to it is applied")
        self.assertEqual(os.listdir(self.media_root()) if os.path.isdir(self.media_root()) else [], [])
        self.assertEqual(doc["counts"]["blocked"], 2)
        self.assertEqual(e.tree.applies, 0)
        # the next run, with a good file, applies both in one transaction
        e.cloud.blobs[m["handle"]]["sha256"] = None
        done = e.run("pull", yes=True)
        self.assertEqual((done["result"], done["counts"]["pulled"]), ("ok", {"create": 1, "update": 1, "delete": 0}))
        self.assertEqual(len(e.tree.undo), 1)

    def test_a_network_failure_defers_only_that_media_object(self):
        e = self.env
        m = new_media(e)
        e.cloud.blobs[m["handle"]] = {"bytes": JPEG, "content_type": "image/jpeg"}
        e.cloud.put(m)
        note = copy.deepcopy(by_gid(load_cloud_objs(e), "N0001"))
        note["format"] = 1
        e.cloud.put(note)
        e.cloud.media_errors[m["handle"]] = transport.TransportError("network", consts.EXIT_TEMPORARY, "retry")
        doc = e.run("pull", yes=True)
        self.assertEqual(doc["result"], "partial")
        self.assertNotIn(m["handle"], e.tree.objects())
        self.assertEqual(e.tree.objects()[note["handle"]]["format"], 1, "the rest of the plan proceeds")
        del e.cloud.media_errors[m["handle"]]
        self.assertEqual(e.run("pull", yes=True)["result"], "ok")
        self.assertIn(m["handle"], e.tree.objects())

    def test_a_media_object_without_a_blob_still_syncs_its_metadata(self):
        e = self.env
        m = new_media(e)
        e.cloud.put(m)  # no blob: the website holds the metadata only (a placeholder or held file)
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0))
        self.assertEqual(e.tree.objects()[m["handle"]]["path"], "")
        self.assertEqual(doc["counts"]["media_down"], 0)

    def test_a_download_url_refused_once_is_asked_for_again_then_deferred(self):
        e = self.env
        m = new_media(e)
        e.cloud.blobs[m["handle"]] = {"bytes": JPEG, "content_type": "image/jpeg"}
        e.cloud.put(m)
        e.cloud.fetch_errors["media-" + m["handle"]] = transport.TransportError("http_403", consts.EXIT_CONFIG, status=403)
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["counts"]["media_down"]), ("ok", 1))
        self.assertEqual(len([c for c in e.cloud.calls if c == "media:" + m["handle"]]), 2, "one fresh URL")

    def test_a_crash_after_the_download_costs_no_second_download(self):
        e = self.env
        m = new_media(e)
        e.cloud.blobs[m["handle"]] = {"bytes": JPEG, "content_type": "image/jpeg"}
        e.cloud.put(m)
        doc = e.run("pull", yes=True, services=fault("after_media"))
        self.assertEqual(doc["result"], "failed")
        self.assertTrue(os.path.exists(os.path.join(self.media_root(), m["handle"] + ".jpg")))
        before = list(e.cloud.calls)
        done = e.run("pull", yes=True)
        self.assertEqual((done["result"], done["counts"]["media_down"]), ("ok", 0), "the file was already there with the right hash")
        self.assertEqual(e.tree.objects()[m["handle"]]["path"], os.path.join(self.media_root(), m["handle"] + ".jpg"))
        new_calls = e.cloud.calls[len(before):]
        self.assertEqual(new_calls.count("fetch"), 1, "only the snapshot was fetched again")

    def test_download_urls_must_be_https_or_loopback_http(self):
        self.assertTrue(media.check_download_url("https://s3.example.org/x?sig=1"))
        self.assertTrue(media.check_download_url("http://127.0.0.1:8080/_s3/x"))
        for bad in ("http://s3.example.org/x", "ftp://example.org/x", "https://user:pw@example.org/x", "file:///etc/passwd", "https:///nohost"):
            with self.assertRaises(transport.TransportError, msg=bad):
                media.check_download_url(bad)


if __name__ == "__main__":
    unittest.main()
