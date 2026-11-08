"""A website-created Media against a real Gramps database (HFY-TSK-410): the pull, then the push plan, with and without the file.

Run by run.sh inside the bundled Python on a copy of the synthetic fixture tree, with the installed addon's `GrampsTree`. What this proves
that tests/unit/test_addon_media_path.py cannot: Gramps' own loader and `object_to_dict` read the Media the pull created (path included),
the file the pull downloads is what `Media.path` points at, and the push plan built from the real database has no op for that Media
(the projection blanks `Media.path`; the website's own path is not a desktop edit), while an edit of another field of it is one op that
keeps the website's path. Everything is invented; the fixture is the synthetic tree.
"""
import copy
import hashlib
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "unit"))
import addon_support as S  # noqa: E402
from test_addon_skeleton import AddonCase  # noqa: E402

try:
    import addon_pull_support as UP  # noqa: E402
except ImportError:  # pragma: no cover
    UP = None

JPEG = b"\xff\xd8\xff\xe0synthetic-lane-photo\xff\xd9"
WEB_PATH = "uploads/web-photo-fictional.jpg"
WEB = "c1" * 14


def load_tool():
    sys.path.insert(0, S.PLUGIN_DIR)
    try:
        import hfy_sync_tool
        from hfygramps.addon import consts, runner
    finally:
        if S.PLUGIN_DIR in sys.path:
            sys.path.remove(S.PLUGIN_DIR)
    return hfy_sync_tool, consts, runner


class WebsiteMediaAgainstGramps(AddonCase):
    def setUp(self):
        super().setUp()
        try:
            self.tool, self.consts, self.runner = load_tool()
        except ImportError:
            self.skipTest("needs the bundled Gramps")

    def objects(self):
        return self.edit(lambda db, DbTxn: self.tool.GrampsTree(db).objects())

    def scenario(self, with_blob):
        from hfygramps.addon import mediafile, paths

        self.bind()
        env = dict(os.environ, HFY_SYNC_PS_CMD="true")
        cfg = paths.read_json(paths.config_path(env))
        cfg["media_root"] = os.path.join(self.dir, "downloaded-media")
        paths.atomic_write_json(paths.config_path(env), cfg)
        before = self.objects()
        fixtures = os.path.join(HERE, "..", "fixtures")
        projected = UP.project_all(before, files=mediafile.collect([o for o in before.values() if o["_class"] == "Media"], fixtures))
        cloud = UP.FakeCloud(self.dbid, UP.heads_of(projected))

        def go(action, **opt):
            def run(db, DbTxn):
                return self.runner.run(self.tool.GrampsTree(db), "cli", self.runner.Options(action, **opt), argv=["gramps"], environ=env,
                                       services={"cloud": cloud})
            return self.edit(run)

        first = go("pull", yes=True)
        self.assertEqual((first["result"], first["exit_code"]), ("ok", 0), first["error"])
        pending = go("check")["counts"]["push_pending"]
        site = copy.deepcopy(next(v["obj"] for v in cloud.heads.values() if v["class"] == "Media"))
        site.update(handle=WEB, gramps_id="O8101", path=WEB_PATH, desc="A website photo (fictional)", mime="image/jpeg", private=False,
                    checksum=hashlib.md5(JPEG).hexdigest(), citation_list=[], note_list=[], tag_list=[])
        if with_blob:
            cloud.blobs[WEB] = {"bytes": JPEG, "content_type": "image/jpeg"}
        cloud.put(site)
        second = go("pull", yes=True)
        self.assertEqual((second["result"], second["exit_code"]), ("ok", 0), second["error"])
        self.assertEqual(second["counts"]["pulled"], {"create": 1, "update": 0, "delete": 0})
        return go, pending, cloud, site

    def check_plan(self, with_blob):
        go, pending, cloud, site = self.scenario(with_blob)
        got = self.objects()[WEB]
        if with_blob:
            self.assertNotEqual(got["path"], WEB_PATH, "the file is down: the path is its local file")
            self.assertTrue(os.path.isfile(got["path"]))
        else:
            self.assertEqual(got["path"], WEB_PATH, "no file: the path stays the website's")
        checked = go("check")
        self.assertEqual(checked["counts"]["pulled"], {"create": 0, "update": 0, "delete": 0}, "nothing to pull")
        self.assertEqual(checked["counts"]["push_pending"], pending, "the pull added nothing to push")
        again = go("pull", yes=True)
        self.assertEqual(again["counts"]["pulled"], {"create": 0, "update": 0, "delete": 0})
        return go, pending, cloud, site

    def test_the_media_the_pull_created_plans_no_push_op_when_its_file_was_not_downloaded(self):
        self.check_plan(False)
        self.assertTrue(self.integrity_ok())

    def test_the_media_the_pull_created_plans_no_push_op_when_its_file_was_downloaded(self):
        self.check_plan(True)
        self.assertTrue(self.integrity_ok())

    def edit_plan(self, with_blob):
        go, pending, cloud, site = self.check_plan(with_blob)

        def edit(db, DbTxn):
            tree = self.tool.GrampsTree(db)
            obj = copy.deepcopy(tree.objects()[WEB])
            obj["desc"] = "Edited on the desktop (fictional)"
            tree.apply("edit", {WEB: obj}, [])
        self.edit(edit)
        self.assertEqual(go("check")["counts"]["push_pending"], pending + 1, "exactly the one edit")
        self.assertEqual(self.objects()[WEB]["desc"], "Edited on the desktop (fictional)")

    def test_a_desktop_edit_of_another_field_is_one_op_in_the_plan_without_the_file(self):
        self.edit_plan(False)

    def test_a_desktop_edit_of_another_field_is_one_op_in_the_plan_with_the_file(self):
        self.edit_plan(True)

    def integrity_ok(self):
        con = S.sqlite_ro(os.path.join(self.dir, "sqlite.db"))
        try:
            return con.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        finally:
            con.close()


if __name__ == "__main__":
    unittest.main()
