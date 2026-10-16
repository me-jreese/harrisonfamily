"""Photo-tag round trip of the end-to-end lane (HFY-TSK-261, tag-roundtrip-e2e; R-31, R-29): a tag made on the website reaches Gramps
through the addon's pull with the identical four integers, a rectangle changed in Gramps and pushed updates the site's region overlay,
and two tags of one person in one photo survive one being moved on the web while the other is edited in Gramps.

    web tag       a tag the website writes (an update of the person's media_list, the way the tagging domain's applyBatch does) comes down as a
                  MediaRef whose rectangle is the same four integers (RT-1)
    overlay       a rectangle changed in Gramps and pushed changes `media/<handle>.json` `regions[]` as the renderer writes it from the store (RT-2)
    two tags      one person, one photo, two tags: the web moves one, Gramps edits the other; after the pull and the push both edits are in
                  Gramps and in the store, and no tag is lost, doubled or conflicted (RT-3)

It runs the real installed wrapper against the local sync dev server on copies of the fixture tree; nothing leaves the machine. The tag
editor's own save path is HFY-TSK for tag-editor-ui; this lane stands in for it with the same op (an `update` of the person head with a
changed `media_list`), as scenario_pull.py stands in for the website's other edits. Fictional data only.
"""
import copy
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "fixtures", "render"))
import e2e_case as C  # noqa: E402
import scenario_pull as PL  # noqa: E402
from hfygramps.render import render_site  # noqa: E402

PHOTO_GID = "O0001"  # the fixture's plain synthetic JPEG
TAGGED_GID = "I0013"  # holds two tags of this photo in the fixture
WEB_PERSON_GID = "I0001"  # holds no tag of it
FIXED_AT = "2000-01-01T00:00:00.000Z"


def tags_of(person, photo_handle):
    """The rectangles of a person's MediaRefs to one photo, as lists of four integers, in list order."""
    return [list(r["rect"]) for r in person.get("media_list", []) if r.get("ref") == photo_handle and r.get("rect") is not None]


def new_tag(photo_handle, rect):
    return {"_class": "MediaRef", "attribute_list": [], "citation_list": [], "note_list": [], "private": False, "rect": list(rect), "ref": photo_handle}


class TagRoundTrip(PL.PullE2E):
    def setUp(self):
        PL.PullE2E.setUp(self)
        self.bring_up()
        self.settle()
        self.photo = PL.by_gid(self.local_objects(), PHOTO_GID)["handle"]

    # ---- the website's side
    def web_tag(self, gid, rect):
        return self.cloud.edit(gid, lambda p: p["media_list"].append(new_tag(self.photo, rect)))

    def web_move(self, gid, index, rect):
        def go(p):
            refs = [r for r in p["media_list"] if r["ref"] == self.photo and r.get("rect") is not None]
            refs[index]["rect"] = list(rect)
        return self.cloud.edit(gid, go)

    def overlay(self):
        """`regions[]` of the photo's media document as the renderer writes it from what the store holds now."""
        objects = [copy.deepcopy(r["obj"]) for r in self.cloud.heads().values() if not r.get("deleted")]
        files = {h: {"checksum": "0" * 64, "size": 1, "ext": ".jpg"} for h in (o["handle"] for o in objects if o["_class"] == "Media")}
        out = render_site(objects, media_files=files, generated_at=FIXED_AT)
        return json.loads(out["media/%s.json" % self.photo].decode("utf-8"))["regions"]

    def regions_for(self, gid):
        return sorted(r["rect"] for r in self.overlay() if r["person"]["grampsId"] == gid)

    # ---- the Gramps side
    def local_tags(self, gid):
        return tags_of(PL.by_gid(self.local_objects(), gid), self.photo)

    def gramps_set_rect(self, gid, old, new):
        def go(db, DbTxn):
            person = db.get_person_from_gramps_id(gid)
            for ref in person.get_media_list():
                if ref.get_reference_handle() == self.photo and list(ref.get_rectangle() or ()) == list(old):
                    ref.set_rectangle(tuple(new))
                    break
            else:
                raise AssertionError("no tag at %s" % (old,))
            with DbTxn("e2e move a tag", db) as trans:
                db.commit_person(person, trans)
        self.edit(go)

    def run_ok(self, *args):
        proc, doc = self.hfy(*args)
        self.assertEqual((proc.returncode, doc["result"]), (0, "ok"), proc.stdout + proc.stderr + json.dumps(doc["error"]))
        return doc

    def run_push(self):
        """A push of the fixture tree ends `partial` (exit 20): its standing holds (private and desktop-only data) are reported, never sent;
        nothing of the tags is held or blocked."""
        proc, doc = self.hfy("push", "--yes")
        self.assertIn((proc.returncode, doc["result"]), ((0, "ok"), (20, "partial")), proc.stdout + proc.stderr + json.dumps(doc["error"]))
        self.assertEqual((doc["counts"]["blocked"], doc["counts"]["conflicts_open"]), (0, 0), json.dumps(doc["error"]))
        return doc

    # --------------------------------------------------------------------------------------------------------------------- RT-1

    def test_a_web_tag_reaches_gramps_with_the_same_four_integers(self):
        rect = [12, 7, 58, 93]
        self.assertEqual(self.local_tags(WEB_PERSON_GID), [])
        self.web_tag(WEB_PERSON_GID, rect)
        self.assertEqual(self.regions_for(WEB_PERSON_GID), [rect], "the site shows the web tag")
        doc = self.run_ok("pull", "--yes")
        self.assertEqual(doc["counts"]["pulled"], {"create": 0, "update": 1, "delete": 0})
        self.assertEqual(self.local_tags(WEB_PERSON_GID), [rect])
        got = self.edit(lambda db, DbTxn: db.get_person_from_gramps_id(WEB_PERSON_GID).get_media_list()[-1].get_rectangle())
        self.assertEqual((type(got), list(got)), (tuple, rect), "Gramps itself reads the same four integers")
        self.assertTrue(all(isinstance(n, int) and not isinstance(n, bool) for n in got))
        again = self.run_ok("pull", "--yes")
        self.assertEqual(again["counts"]["pulled"], {"create": 0, "update": 0, "delete": 0})

    # --------------------------------------------------------------------------------------------------------------------- RT-2

    def test_a_rect_changed_in_gramps_and_pushed_updates_the_sites_overlay(self):
        rect, moved = [12, 7, 58, 93], [20, 15, 70, 85]
        self.web_tag(WEB_PERSON_GID, rect)
        self.run_ok("pull", "--yes")
        self.assertEqual(self.regions_for(WEB_PERSON_GID), [rect])
        self.gramps_set_rect(WEB_PERSON_GID, rect, moved)
        doc = self.run_push()
        self.assertEqual(self.local_tags(WEB_PERSON_GID), [moved])
        self.assertEqual(self.cloud.get(WEB_PERSON_GID)["media_list"][-1]["rect"], moved)
        self.assertEqual(self.regions_for(WEB_PERSON_GID), [moved], "the overlay follows the pushed rectangle")
        self.assertNotIn(rect, [r["rect"] for r in self.overlay()])
        self.assertIsNotNone(doc)

    # --------------------------------------------------------------------------------------------------------------------- RT-3

    def test_two_tags_of_one_person_in_one_photo_both_survive_a_web_move_and_a_gramps_edit(self):
        first, second = self.local_tags(TAGGED_GID)[:2]
        self.assertEqual((first, second), ([10, 10, 40, 40], [50, 10, 90, 40]), "the fixture's two tags")
        web_rect, gramps_rect = [5, 5, 35, 45], [55, 15, 85, 35]
        self.web_move(TAGGED_GID, 0, web_rect)
        self.gramps_set_rect(TAGGED_GID, second, gramps_rect)
        self.run_ok("pull", "--yes")
        self.assertEqual(self.local_tags(TAGGED_GID), [web_rect, gramps_rect], "the web move came down and the local edit stayed")
        self.run_push()
        self.assertEqual(self.local_tags(TAGGED_GID), [web_rect, gramps_rect])
        self.assertEqual(tags_of(self.cloud.get(TAGGED_GID), self.photo), [web_rect, gramps_rect], "the store holds both")
        self.assertEqual(self.regions_for(TAGGED_GID), sorted([web_rect, gramps_rect]), "the overlay shows both")
        self.assertEqual(self.server.conflicts(), [], "no conflict was opened")


if __name__ == "__main__":
    unittest.main()
