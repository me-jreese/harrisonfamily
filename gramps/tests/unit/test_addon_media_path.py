"""A desktop push must never blank the website's own Media path (HFY-TSK-410).

    cd gramps/tests/unit && python3 -m unittest test_addon_media_path

A Media created on the website carries a non-empty `path` (its uploaded file) in the cloud object and in the base row. The projection
keeps `Media.path` on the desktop (rule media.path.local_only: a path is a file on this Mac) and always sends it blank, so the planner
saw the projected local object ('') against the base (non-empty) and planned an 'update' that would have erased the website's path.

The cases follow the real flow, with the file not downloaded (the path stays the website's) and downloaded (the path becomes a local
file path): a pulled website Media plans no op, a desktop edit of another field plans exactly that edit and the object sent keeps the
website's path, and a Media made on the desktop still goes up as before. The website is push_support.FakeCloud; every value is invented.
"""
import copy
import hashlib
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import push_support as PS  # noqa: E402
from test_addon_push import PushCase  # noqa: E402
from hfygramps import canonical, merge as M, projection as PR  # noqa: E402
from hfygramps.addon import consts, paths, transport  # noqa: E402

JPEG = b"\xff\xd8\xff\xe0synthetic-web-photo\xff\xd9"
WEB_PATH = "uploads/web-photo-fictional.jpg"
WEB = "c1" * 14


class WebView(PS.PullView):
    """A pull view that serves the website's blob when there is one and says there is none otherwise."""

    calls = []

    def media_download(self, handle):
        blob = self.cloud.blobs.get(handle)
        if blob is None:
            raise transport.TransportError("no_blob", consts.EXIT_INTERNAL, status=404)
        WebView.calls.append(handle)
        url = "https://blob.invalid/%s" % handle
        self.cloud.snapshot_files[url] = self.cloud.blob_bytes(handle)
        return {"url": url, "sha256": blob["sha256"], "md5": blob["md5"], "size": blob["size"], "content_type": blob["content_type"]}


class WebsiteMedia(PushCase):
    full = True
    tree_class = PS.MediaPushTree

    def setUp(self):
        PushCase.setUp(self)
        cfg = paths.read_json(paths.config_path(self.env))
        cfg["media_root"] = os.path.join(self.tmp, "mroot")
        paths.atomic_write_json(paths.config_path(self.env), cfg)
        WebView.calls = []
        self.seed()

    def web_media(self, handle=WEB, gid="O8101", with_blob=True, path=WEB_PATH):
        """A Media the website created: its own `path`, a checksum and (optionally) a present blob. Put straight into the fake store."""
        obj = copy.deepcopy(self.cloud.heads[self.tree.by_id("Media", "O0001")["handle"]]["obj"])
        obj.update(handle=handle, gramps_id=gid, path=path, desc="A website photo (fictional)", mime="image/jpeg", private=False,
                   checksum=hashlib.md5(JPEG).hexdigest(), citation_list=[], note_list=[], tag_list=[])
        self.cloud.seq += 1
        self.cloud.heads[handle] = {"class": "Media", "version": 1, "seq": self.cloud.seq, "deleted": False, "gramps_id": gid, "obj": obj}
        if with_blob:
            key = "media/%s.jpg" % handle
            self.cloud.final[key] = JPEG
            self.cloud.blobs[handle] = {"s3_key": key, "sha256": hashlib.sha256(JPEG).hexdigest(), "md5": hashlib.md5(JPEG).hexdigest(),
                                        "size": len(JPEG), "content_type": "image/jpeg", "state": "present"}
        return obj

    def pull_web(self):
        from hfygramps.addon import runner
        self.n += 1
        doc = runner.run(self.tree, "cli", runner.Options("pull", yes=True), run_id="r%02d" % self.n, argv=["gramps"], environ=self.env,
                         services={"cloud": WebView(self.cloud)})
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc.get("error"))
        return doc

    def sent(self):
        return len(self.cloud.pushed_ops())

    def assert_no_push(self):
        look = self.push(dry_run=True)
        self.assertEqual(look["counts"]["pushed"], {"create": 0, "update": 0, "delete": 0}, "the plan has no op")
        before, version = self.sent(), self.cloud.heads[WEB]["version"]
        doc = self.push()
        self.assertEqual(doc["counts"]["pushed"], {"create": 0, "update": 0, "delete": 0})
        self.assertEqual(self.sent(), before)
        self.assertEqual(self.cloud.heads[WEB]["version"], version)

    # ---- the two variants of the finding
    def test_a_pulled_website_media_whose_file_was_not_downloaded_plans_no_op(self):
        site = self.web_media(with_blob=False)
        self.pull_web()
        self.assertEqual(WebView.calls, [])
        self.assertEqual(self.tree.data[WEB]["path"], WEB_PATH, "no file: the path stays the website's")
        self.assert_no_push()
        self.assertEqual(self.cloud.heads[WEB]["obj"], site)

    def test_a_pulled_website_media_whose_file_was_downloaded_plans_no_op(self):
        site = self.web_media()
        self.pull_web()
        self.assertEqual(WebView.calls, [WEB])
        local = self.tree.data[WEB]["path"]
        self.assertNotEqual(local, WEB_PATH, "the file is downloaded: the path is a local file path now")
        self.assertTrue(os.path.isabs(local) or local.startswith(self.tmp))
        self.assert_no_push()
        self.assertEqual(self.cloud.heads[WEB]["obj"], site)
        self.assertEqual(self.cloud.heads[WEB]["obj"]["path"], WEB_PATH)

    def test_the_base_row_stays_exactly_the_websites_object_and_hash(self):
        for blob in (False, True):
            with self.subTest(downloaded=blob):
                handle = ("c%d" % (2 + blob)) * 14
                site = self.web_media(handle=handle, gid="O810%d" % (2 + blob), with_blob=blob)
                self.pull_web()
                self.push()
                row = self.rows("SELECT obj_json, hash FROM base WHERE handle = ?", handle)[0]
                self.assertEqual(canonical.object_hash(__import__("json").loads(row[0])), row[1])
                self.assertEqual(__import__("json").loads(row[0]), site)
                self.assertEqual(row[1], canonical.object_hash(site))

    # ---- a desktop edit of another field
    def edit_and_push(self, with_blob):
        site = self.web_media(with_blob=with_blob)
        self.pull_web()
        self.tree.edit(WEB, lambda o: o.update(desc="Edited on the desktop (fictional)"))
        before = self.sent()
        look = self.push(dry_run=True)
        self.assertEqual(look["counts"]["pushed"], {"create": 0, "update": 1, "delete": 0}, "exactly the one edit")
        doc = self.push()
        self.assertEqual(doc["counts"]["pushed"], {"create": 0, "update": 1, "delete": 0})
        ops = self.cloud.pushed_ops()[before:]
        self.assertEqual([(o["op"], o["class"], o["handle"]) for o in ops], [("update", "Media", WEB)])
        return site, ops[0]

    def test_a_desktop_edit_of_another_field_sends_that_edit_and_keeps_the_websites_path_not_downloaded(self):
        site, op = self.edit_and_push(False)
        self.assertEqual(op["obj"]["path"], WEB_PATH)
        self.assertEqual(op["obj"], dict(site, desc="Edited on the desktop (fictional)"))
        self.assertEqual(self.cloud.heads[WEB]["obj"]["path"], WEB_PATH)
        self.assert_no_push()

    def test_a_desktop_edit_of_another_field_sends_that_edit_and_keeps_the_websites_path_downloaded(self):
        site, op = self.edit_and_push(True)
        self.assertEqual(op["obj"]["path"], WEB_PATH)
        self.assertEqual(op["obj"], dict(site, desc="Edited on the desktop (fictional)"))
        self.assertEqual(self.cloud.heads[WEB]["obj"]["path"], WEB_PATH)
        self.assertNotEqual(self.tree.data[WEB]["path"], WEB_PATH, "the desktop still points at its own file")
        self.assert_no_push()

    def test_no_push_ever_sends_a_blank_path_over_a_non_empty_one(self):
        for blob in (False, True):
            self.web_media(handle=("d%d" % blob) * 14, gid="O820%d" % blob, with_blob=blob)
        self.pull_web()
        for h in (("d0") * 14, ("d1") * 14):
            self.tree.edit(h, lambda o: o.update(desc="Edited (fictional)"))
        self.push()
        for op in self.cloud.pushed_ops():
            if op["class"] == "Media" and op["op"] == "update":
                self.assertTrue(op["obj"]["path"], "a blank path over the website's")

    # ---- the desktop's own Media is unchanged
    def test_a_desktop_created_media_still_pushes_with_its_path_blank_and_edits_update_it(self):
        mine = copy.deepcopy(self.tree.by_id("Media", "O0001"))
        handle = "e1" * 14
        mine.update(handle=handle, gramps_id="O0100", path="media/mine.jpg", desc="Mine (fictional)")
        self.tree.data[handle] = mine
        doc = self.push()
        self.assertEqual(doc["counts"]["pushed"]["create"], 1, doc["counts"])
        self.assertEqual(self.cloud.heads[handle]["obj"]["path"], "", "a path is a file on this Mac: it goes up blank")
        self.tree.edit(handle, lambda o: o.update(desc="Mine, edited (fictional)"))
        doc = self.push()
        self.assertEqual(doc["counts"]["pushed"], {"create": 0, "update": 1, "delete": 0})
        self.assertEqual(self.cloud.heads[handle]["obj"]["desc"], "Mine, edited (fictional)")
        self.assertEqual(self.cloud.heads[handle]["obj"]["path"], "")
        self.tree.edit(handle, lambda o: o.update(path="media/moved.jpg"))
        self.assertEqual(self.push(dry_run=True)["counts"]["pushed"], {"create": 0, "update": 0, "delete": 0}, "moving the file is not an edit")

    # ---- the website changes its own path
    def test_the_website_replacing_its_path_is_no_desktop_edit_and_no_conflict(self):
        self.web_media()
        self.pull_web()
        self.cloud.edit(WEB, lambda o: o.update(path="uploads/replaced-fictional.jpg"))
        self.pull_web()
        self.assert_no_push()
        self.assertEqual(self.cloud.heads[WEB]["obj"]["path"], "uploads/replaced-fictional.jpg")


class MergeLevel(unittest.TestCase):
    """merge_object on its own: the website's Media against a desktop copy whose projection blanks the path."""

    def site(self, path=WEB_PATH, desc="A"):
        return {"_class": "Media", "handle": WEB, "gramps_id": "O8101", "path": path, "desc": desc, "mime": "image/jpeg", "checksum": "a" * 32,
                "private": False, "note_list": [], "tag_list": [], "citation_list": [], "attribute_list": [], "date": None}

    def run_merge(self, base, cloud, local_path="/Users/example/pictures/web.jpg", desc="A"):
        local = dict(self.site(path=local_path, desc=desc))
        projected = PR.project_tree([local])[0][WEB]
        self.assertEqual(projected["path"], "", "the projection blanks it")
        return M.merge_object(base, local, projected, cloud, cloud_version=3, project_fn=lambda o: PR.project_tree([o])[0][WEB])

    def test_the_projection_declares_its_local_only_keys(self):
        self.assertEqual(PR.local_only_keys("Media"), {"path": ""})
        self.assertEqual(PR.local_only_keys("Event"), {})
        local_only = PR.local_only_keys("Media")
        local_only["x"] = 1
        self.assertEqual(PR.local_only_keys("Media"), {"path": ""}, "a copy")

    def test_the_websites_path_against_the_desktops_blank_is_no_change_in_either_direction(self):
        base = self.site()
        cloud = copy.deepcopy(base)
        res = self.run_merge(base, cloud)
        self.assertEqual((res.action, res.push, res.local_obj, res.conflicts), ("unchanged", None, None, []))
        self.assertIs(res.base_after, cloud, "the base row follows the website's object itself")

    def test_a_desktop_edit_of_another_field_pushes_that_field_with_the_websites_path(self):
        base = self.site()
        cloud = copy.deepcopy(base)
        res = self.run_merge(base, cloud, desc="Edited")
        self.assertEqual(res.action, "update")
        self.assertEqual(res.push["obj"], self.site(desc="Edited"))
        self.assertEqual(res.base_after, res.push["obj"])
        self.assertEqual(cloud, base, "the inputs are untouched")

    def test_a_website_edit_of_another_field_is_taken_and_the_path_is_left_alone(self):
        base = self.site()
        cloud = self.site(desc="Website edit")
        res = self.run_merge(base, cloud)
        self.assertEqual((res.action, res.push), ("update", None))
        self.assertEqual(res.local_obj["desc"], "Website edit")
        self.assertEqual(res.local_obj["path"], "/Users/example/pictures/web.jpg", "the desktop keeps its own file")
        self.assertEqual(res.base_after, cloud)

    def test_the_website_replacing_its_path_while_the_desktop_edits_another_field_is_not_a_conflict(self):
        base = self.site()
        cloud = self.site(path="uploads/replaced.jpg")
        res = self.run_merge(base, cloud, desc="Edited")
        self.assertEqual(res.conflicts, [])
        self.assertEqual(res.push["obj"], self.site(path="uploads/replaced.jpg", desc="Edited"), "the website's newest path")

    def test_a_desktop_media_with_no_website_path_is_as_before(self):
        base = self.site(path="")
        res = self.run_merge(base, copy.deepcopy(base), desc="Edited")
        self.assertEqual(res.push["obj"], self.site(path="", desc="Edited"))
        self.assertEqual(self.run_merge(base, copy.deepcopy(base)).action, "unchanged")

    def test_a_cloud_object_without_the_path_key_pushes_no_blank_path(self):
        """A sparse website Media (no `path` key at all): the desktop's blank is no edit, and there is no website path for a push to erase."""
        base = self.site()
        del base["path"]
        cloud = copy.deepcopy(base)
        res = self.run_merge(base, cloud)
        self.assertEqual((res.action, res.push, res.conflicts), ("unchanged", None, []))
        res = self.run_merge(base, cloud, desc="Edited")
        self.assertEqual(res.action, "update")
        self.assertEqual(res.conflicts, [])
        self.assertEqual(res.push["obj"].get("desc"), "Edited")
        # the projection's blank over a key the website never had loses nothing (no website path exists to erase)
        self.assertEqual(res.push["obj"].get("path", ""), "")
        self.assertEqual(cloud, base, "the inputs are untouched")

    def test_an_object_level_conflict_shows_the_websites_path_not_the_parked_blank(self):
        """delete_edit: the website deleted the Media, the desktop edited it. The conflict's base holds the website's path as it was."""
        base = self.site()
        local = self.site(path="/Users/example/pictures/web.jpg", desc="Edited")
        projected = PR.project_tree([local])[0][WEB]
        res = M.merge_object(base, local, projected, M.TOMBSTONE, cloud_version=3,
                             project_fn=lambda o: PR.project_tree([o])[0][WEB])
        self.assertEqual(res.action, "conflict")
        (c,) = res.conflicts
        self.assertEqual(c["path"], "")
        self.assertEqual(c["base"]["path"], WEB_PATH)
        self.assertEqual(json.loads(c["base_json"])["path"], WEB_PATH)
        self.assertIs(res.base_after, base)
        # no common base: the cloud copy in the conflict is the website's, path included
        cloud = self.site(desc="Website")
        res = M.merge_object(None, local, projected, cloud, cloud_version=3, project_fn=lambda o: PR.project_tree([o])[0][WEB])
        self.assertEqual(res.action, "conflict")
        (c,) = res.conflicts
        self.assertEqual(c["cloud"]["path"], WEB_PATH)
        self.assertEqual(json.loads(c["cloud_json"])["path"], WEB_PATH)

    def test_a_downloaded_file_whose_md5_differs_from_the_stored_checksum_is_the_checksum_derive_rule(self):
        """The projection derives `checksum` from the file on disk (media.checksum.derive): a stored checksum that is not the file's md5 is
        corrected by one update, which carries the website's path and sends the md5 once; it is then at rest."""
        base = self.site()
        cloud = copy.deepcopy(base)
        local = self.site(path="/Users/example/pictures/web.jpg")
        files = {WEB: {"exif_gps": False, "md5": hashlib.md5(JPEG).hexdigest(), "readable": True}}
        projected = PR.project_tree([local], files=files)[0][WEB]
        self.assertEqual(projected["checksum"], hashlib.md5(JPEG).hexdigest())
        self.assertNotEqual(projected["checksum"], cloud["checksum"])
        fn = lambda o: PR.project_tree([o], files=files)[0][WEB]  # noqa: E731
        res = M.merge_object(base, local, projected, cloud, cloud_version=3, project_fn=fn)
        self.assertEqual(res.conflicts, [])
        self.assertEqual(res.action, "update")
        self.assertEqual(res.push["obj"]["path"], WEB_PATH, "never blanked by the checksum change")
        self.assertEqual(res.push["obj"]["checksum"], hashlib.md5(JPEG).hexdigest())
        # once the website holds that checksum nothing is planned
        site2 = self.site()
        site2["checksum"] = hashlib.md5(JPEG).hexdigest()
        local2 = dict(local, checksum=site2["checksum"])
        proj2 = PR.project_tree([local2], files=files)[0][WEB]
        res = M.merge_object(site2, local2, proj2, copy.deepcopy(site2), cloud_version=4, project_fn=fn)
        self.assertEqual((res.action, res.push), ("unchanged", None))

    def test_other_classes_and_other_keys_are_compared_as_they_were(self):
        note = {"_class": "Note", "handle": "n" * 28, "gramps_id": "N1", "path": "x", "format": 0, "private": False, "tag_list": []}
        self.assertIs(M._park_local_only(note), note)
        media = self.site()
        parked = M._park_local_only(media)
        self.assertEqual(parked, self.site(path=""))
        self.assertEqual(media["path"], WEB_PATH)
        blank = self.site(path="")
        self.assertIs(M._park_local_only(blank), blank)
        self.assertEqual(M._park_local_only(M.TOMBSTONE), M.TOMBSTONE)
        self.assertIsNone(M._park_local_only(None))


if __name__ == "__main__":
    unittest.main()
