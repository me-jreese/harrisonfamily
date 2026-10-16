"""Media scenarios of the end-to-end lane (HFY-TSK-207, addon-media): the addon's media sync against the local sync dev server (its S3 is a
directory, its presigner enforces the signed type, length and SHA-256 of a PUT, and its handler runs the real finalize), on copies of the
fixture tree and real files.

    upload        a new photo with a tagged MediaRef is uploaded with a signed SHA-256 to media/.staging/<handle>/<sha256>; the Media head records the
                  blob's sha256, md5 and size, the rect is the same four integers, and the Media op moves the bytes to media/<handle>.jpg
    checksum      a stale Gramps MD5 gives a warning in the preview and the disk MD5 is what the website gets
    held          the fixture's GPS photo, 0-byte placeholder and PDF: the photo and the PDF are not sent, the placeholder's metadata syncs without a
                  blob, and each has a hold with guidance
    409           a changed file is uploaded and the Media op meets a 409 (a website edit raced it): the served key and the head's blob are as they
                  were, and the next run converges (head.blob.sha256 is always the sha256 of the object at media/<handle><ext>)
    empty         a good cloud blob is never replaced by an empty file
    download      a website-created photo comes down; one that carries a GPS position is held on download and never written

The push needs only to READ the Gramps tree, so (as in scenario_push.py) the runner is called in this process with the real
hfy_sync_tool.GrampsTree; the download scenarios run the real installed wrapper like scenario_pull.py. Fictional data only.
"""
import base64
import copy
import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_case as C  # noqa: E402
import scenario_pull as PL  # noqa: E402
import scenario_push as P  # noqa: E402
from hfygramps.addon import mediafile, transport  # noqa: E402

JFIF = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
FIXTURE_MEDIA = os.path.join(HERE, "..", "fixtures", "media")
NEW_HANDLE = "ee00000000000000000000000001"
GPS_HANDLE = "ee00000000000000000000000002"
BUCKET = "hfy-dev-media"


def jpeg(tag):
    """A small synthetic JPEG with no metadata; `tag` makes its bytes unique."""
    return JFIF + b"\xff\xdb\x00\x05abc\xff\xda\x00\x04\x00\x00synthetic-" + tag.encode("ascii") + b"\xff\xd9"


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def sha256_b64(data):
    return base64.b64encode(hashlib.sha256(data).digest()).decode("ascii")


class MediaUp(P.PushCase):
    def setUp(self):
        P.PushCase.setUp(self)
        self.photos = tempfile.mkdtemp(prefix="hfy-e2e-photos-")
        self.addCleanup(shutil.rmtree, self.photos, True)

    # ---- the website's blob store and heads
    def s3_path(self, key):
        return os.path.join(self.server.data_dir, "s3", "objects", BUCKET, *key.split("/"))

    def s3_bytes(self, key):
        try:
            with open(self.s3_path(key), "rb") as fh:
                return fh.read()
        except OSError:
            return None

    def head_blob(self, handle):
        """The Media head's blob as the download route reports it, or None (404 no_blob)."""
        try:
            return self.reader.post("/api/sync/media/%s/download" % handle, {}).body
        except transport.TransportError as exc:
            if exc.status == 404 and exc.code == "no_blob":
                return None
            raise

    def check_blob_invariant(self, handle):
        """head.blob.sha256 always matches the object at media/<handle><ext>."""
        blob = self.head_blob(handle)
        self.assertIsNotNone(blob)
        served = self.s3_bytes("media/%s.jpg" % handle)
        self.assertIsNotNone(served, "nothing is served at the blob's key")
        self.assertEqual(sha256_hex(served), blob["sha256"])
        self.assertEqual((hashlib.md5(served).hexdigest(), len(served)), (blob["md5"], blob["size"]))
        return blob

    # ---- a photo in the Gramps tree
    def add_photo(self, data, rect, gid="O0900", person_gid="I0013", stale_md5=None):
        path = os.path.join(self.photos, "photo-%s.jpg" % gid)
        with open(path, "wb") as fh:
            fh.write(data)

        def go(db, DbTxn):
            from gramps.gen.lib import Media, MediaRef
            with DbTxn("e2e add photo", db) as trans:
                media = Media()
                media.set_path(path)
                media.set_mime_type("image/jpeg")
                media.set_description("A new synthetic photo")
                media.set_gramps_id(gid)
                media.set_checksum(stale_md5 or hashlib.md5(data).hexdigest())
                db.add_media(media, trans)
                person = db.get_person_from_gramps_id(person_gid)
                ref = MediaRef()
                ref.set_reference_handle(media.handle)
                ref.set_rectangle(tuple(rect) if rect else None)
                person.add_media_reference(ref)
                db.commit_person(person, trans)
                return media.handle
        handle = self.edit(go)
        return handle, path

    def set_checksum(self, handle, md5, desc=None):
        def go(db, DbTxn):
            media = db.get_media_from_handle(handle)
            media.set_checksum(md5)
            if desc:
                media.set_description(desc)
            with DbTxn("e2e edit media", db) as trans:
                db.commit_media(media, trans)
        self.edit(go)

    def preview_of(self, doc):
        path = os.path.join(os.path.dirname(C.S.tree_paths(self.dbid)["sidecar"]), "previews", "%s.json" % doc["run_id"])
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)

    # ---------------------------------------------------------------------------------------------------------------- upload

    def test_a_new_photo_with_a_tagged_rect_uploads_with_a_signed_sha256(self):  # AC1
        self.seed()
        data = jpeg("one")
        handle, path = self.add_photo(data, rect=(10, 20, 60, 80))
        mark = len(self.server.entries())
        doc = self.push()
        self.assertEqual(doc["counts"]["media_up"], 1, doc)
        puts = [e for e in self.server.entries()[mark:] if e["method"] == "PUT"]
        self.assertEqual(len(puts), 1)
        self.assertEqual(puts[0]["path"], "/_s3/%s/media/.staging/%s/%s" % (BUCKET, handle, sha256_hex(data)))
        self.assertEqual((puts[0]["query"]["sha"], puts[0]["query"]["ct"], int(puts[0]["query"]["size"])), (sha256_b64(data), "image/jpeg", len(data)),
                         "the URL was signed for this body's SHA-256, type and length")
        self.assertEqual(puts[0]["status"], 200)
        self.assertEqual(puts[0]["auth"], "none", "no bearer token goes to the blob store")
        blob = self.check_blob_invariant(handle)
        self.assertEqual((blob["sha256"], blob["md5"], blob["size"]), (sha256_hex(data), hashlib.md5(data).hexdigest(), len(data)))
        self.assertIsNone(self.s3_bytes("media/.staging/%s/%s" % (handle, sha256_hex(data))), "finalize removed the staging object")
        head = self.heads()[handle]
        self.assertEqual(head["obj"]["checksum"], hashlib.md5(data).hexdigest())
        self.assertEqual(head["obj"]["path"], "", "the path never leaves the Mac")
        person = self.head_of("I0013")
        tagged = [r for r in person["obj"]["media_list"] if r["ref"] == handle]
        self.assertEqual([r["rect"] for r in tagged], [[10, 20, 60, 80]], "the rect is stored as the same four integers")
        self.assertTrue(all(type(v) is int for v in tagged[0]["rect"]))
        self.assertEqual(self.server.grep(self.photos), [], "no local path is in the request log")
        row = self.rows("SELECT path, md5, sha256, size, origin FROM media_local WHERE handle = ?", handle)
        self.assertEqual(row, [(path, hashlib.md5(data).hexdigest(), sha256_hex(data), len(data), "up")])
        puts = len([e for e in self.server.entries() if e["method"] == "PUT"])
        again = self.push()
        self.assertEqual(again["counts"]["media_up"], 0)
        self.assertEqual(len([e for e in self.server.entries() if e["method"] == "PUT"]), puts, "the same bytes are not uploaded twice")

    def test_a_stale_gramps_md5_is_a_warning_and_the_disk_md5_is_sent(self):  # AC4
        self.seed()
        data = jpeg("two")
        handle, _path = self.add_photo(data, rect=None, stale_md5="0" * 32)
        doc = self.push(dry_run=True)
        preview = self.preview_of(doc)
        self.assertEqual([(w["rule"], w["handle"]) for w in preview["warnings"]], [("media_checksum_stale", handle)])
        self.assertEqual(preview["counts"]["media_up"], 1)
        self.push()
        self.assertEqual(self.heads()[handle]["obj"]["checksum"], hashlib.md5(data).hexdigest())
        self.assertEqual(self.head_blob(handle)["md5"], hashlib.md5(data).hexdigest())
        self.assertEqual(self.server.grep("0" * 32), [], "the stale value never left the Mac")

    def test_the_fixture_files_that_cannot_go_are_held_with_guidance(self):  # AC3
        self.seed()
        by = {o["gramps_id"]: o for o in self.data.values() if o["_class"] == "Media"}
        heads = self.heads()
        self.assertNotIn(by["O0002"]["handle"], heads, "the photo with a GPS location is not sent")
        self.assertNotIn(by["O0004"]["handle"], heads, "the PDF stays until io releases it")
        self.assertIn(by["O0003"]["handle"], heads, "the placeholder's metadata syncs")
        self.assertIsNone(self.head_blob(by["O0003"]["handle"]), "and no blob is made up for it")
        self.assertEqual(self.check_blob_invariant(by["O0001"]["handle"])["md5"], by["O0001"]["checksum"])
        holds = {h: (r, d) for h, r, d in self.rows("SELECT handle, rule, detail FROM holds WHERE class = 'Media'")}
        self.assertEqual(holds[by["O0002"]["handle"]][0], "media.exif_gps.hold")
        self.assertIn("location", holds[by["O0002"]["handle"]][1])
        self.assertEqual(holds[by["O0003"]["handle"]][0], "media_blob_empty")
        self.assertIn("offline", holds[by["O0003"]["handle"]][1])
        self.assertEqual(self.s3_bytes("media/%s.jpg" % by["O0002"]["handle"]), None)

    def test_a_good_cloud_blob_is_never_replaced_by_an_empty_file(self):  # AC3
        self.seed()
        data = jpeg("three")
        handle, path = self.add_photo(data, rect=None)
        self.push()
        open(path, "wb").close()
        self.set_checksum(handle, hashlib.md5(data).hexdigest(), desc="Edited on the desktop")
        self.push()
        self.assertEqual(self.heads()[handle]["obj"]["desc"], "Edited on the desktop", "the metadata edit synced")
        self.assertEqual(self.s3_bytes("media/%s.jpg" % handle), data)
        self.assertEqual(self.head_blob(handle)["sha256"], sha256_hex(data))
        self.check_blob_invariant(handle)

    # ------------------------------------------------------------------------------------------------------------------ 409

    def test_a_409_after_the_upload_leaves_the_served_blob_and_metadata_and_the_next_run_converges(self):  # AC5
        self.seed()
        old, new = jpeg("four"), jpeg("five")
        handle, path = self.add_photo(old, rect=None)
        self.push()
        before = self.check_blob_invariant(handle)
        head_before = self.heads()[handle]
        with open(path, "wb") as fh:
            fh.write(new)
        self.set_checksum(handle, hashlib.md5(new).hexdigest())
        http = P.FaultyHttp()
        http.before_batch = lambda: self.web_edit(handle, lambda o: o.__setitem__("desc", "Edited on the website"), "race-media-1")
        doc = self.push(http=http)
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"]), ("partial", 75, "retry"))
        self.assertEqual(http.answers[-1][0], 409)
        self.assertEqual(self.s3_bytes("media/.staging/%s/%s" % (handle, sha256_hex(new))), new, "the new bytes were uploaded to the staging key")
        self.assertEqual(self.s3_bytes("media/%s.jpg" % handle), old, "and the served key still has the old bytes")
        self.assertEqual(self.head_blob(handle), dict(before, url=self.head_blob(handle)["url"], expires_in=self.head_blob(handle)["expires_in"]),
                         "the head still names the old blob")
        self.check_blob_invariant(handle)
        head_now = self.heads()[handle]
        self.assertEqual(head_now["obj"]["checksum"], head_before["obj"]["checksum"], "members never see the new metadata with the old bytes")
        self.assertEqual(head_now["obj"]["desc"], "Edited on the website")
        self.assertEqual(self.rows("SELECT sha256 FROM media_local WHERE handle = ?", handle), [(sha256_hex(old),)])
        doc = self.push()                                                    # the next run converges
        self.assertIn(doc["exit_code"], (0, 20), doc)
        blob = self.check_blob_invariant(handle)
        self.assertEqual(blob["sha256"], sha256_hex(new))
        self.assertEqual(self.s3_bytes("media/%s.jpg" % handle), new)
        self.assertIsNone(self.s3_bytes("media/.staging/%s/%s" % (handle, sha256_hex(new))), "finalize cleaned the staging object")
        self.assertEqual(self.heads()[handle]["obj"]["checksum"], hashlib.md5(new).hexdigest())
        self.assertEqual(self.rows("SELECT sha256 FROM media_local WHERE handle = ?", handle), [(sha256_hex(new),)])


class MediaDown(PL.PullE2E):
    def test_a_website_photo_with_a_gps_position_is_held_on_download(self):  # AC2, AC3
        self.bring_up()
        self.settle()
        with open(os.path.join(FIXTURE_MEDIA, "synthetic-photo-gps.jpg"), "rb") as fh:
            gps = fh.read()
        self.assertTrue(mediafile.exif_gps(gps))
        media = copy.deepcopy(self.projected["95c1e2e76d98047b229a3390d414"])
        media.update(handle=GPS_HANDLE, gramps_id="O0901", checksum=hashlib.md5(gps).hexdigest(), path="", desc="Added on the website (fictional)")
        self.cloud.create(media, blob={"bytes": gps, "content_type": "image/jpeg"})
        proc, doc = self.hfy("pull", "--yes")
        self.assertEqual((proc.returncode, doc["result"]), (20, "partial"), proc.stdout + proc.stderr + json.dumps(doc["error"]))
        self.assertEqual(doc["counts"]["media_down"], 0)
        self.assertFalse(os.path.isdir(self.media_root) and os.listdir(self.media_root), "nothing with a location reaches the disk")
        got = PL.by_gid(self.local_objects(), "O0901")
        self.assertEqual(got["path"], "", "the metadata is applied, with no local path")
        self.assertEqual(self.table("SELECT COUNT(*) FROM media_local")[0][0], 0)
        rows = self.table("SELECT class, handle, rule, path FROM holds WHERE handle = ?", GPS_HANDLE)
        self.assertEqual(rows, [("Media", GPS_HANDLE, "media.exif_gps.hold", "/blob")])

    def test_a_clean_website_photo_comes_down_exif_checked_and_linked(self):  # AC2
        self.bring_up()
        self.settle()
        with open(os.path.join(FIXTURE_MEDIA, "synthetic-photo-plain.jpg"), "rb") as fh:
            data = fh.read()
        media = copy.deepcopy(self.projected["95c1e2e76d98047b229a3390d414"])
        media.update(handle=NEW_HANDLE, gramps_id="O0902", checksum=hashlib.md5(data).hexdigest(), path="", desc="Graduated from a comment (fictional)")
        self.cloud.create(media, blob={"bytes": data, "content_type": "image/jpeg"})
        proc, doc = self.hfy("pull", "--yes")
        self.assertEqual((proc.returncode, doc["result"], doc["counts"]["media_down"]), (0, "ok", 1), proc.stdout + proc.stderr)
        got = PL.by_gid(self.local_objects(), "O0902")
        self.assertEqual(got["path"], os.path.join(self.media_root, NEW_HANDLE + ".jpg"))
        self.assertEqual(PL.sha256_file(got["path"]), sha256_hex(data))
        self.assertEqual(self.table("SELECT handle, md5, sha256, size, origin FROM media_local"),
                         [(NEW_HANDLE, hashlib.md5(data).hexdigest(), sha256_hex(data), len(data), "cloud")])


if __name__ == "__main__":
    unittest.main()
