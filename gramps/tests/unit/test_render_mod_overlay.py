"""hfy-sync-render, the MOD# overlay (HFY-TSK-216, hfy-moderation-record-targets; BRD2 D2-19, D2-34, review DL-15, PS-07).

A hidden note, MediaRef or Media is absent from every rendered key, a moderation marker wakes the pass, an unhide brings the item back, and an unreadable overlay
stops the pass (fail closed). Standard library only; the synthetic tree is the only data. Run: python3 -m unittest discover gramps/tests/unit
"""

import json
import re
import unittest

import render_lambda_support as sup
import render_support as rs
from hfy_render import errors, overlay
from hfy_render.view import StoreView

import test_render_lambda as base


def rig(**kw):
    table = sup.FakeTable()
    store = sup.fixture_store(table)
    r = sup.Rig("live", store=store, **kw)
    r.overlay = overlay.ModOverlay(table)
    r.run()
    return r


def new_rig():
    table = sup.FakeTable()
    store = sup.fixture_store(table)
    r = sup.Rig("live", store=store)
    r.overlay = overlay.ModOverlay(table)
    return r


def stable(files):
    """The site without its generation time (a pass stamps the time of the last log entry into the indexes)."""

    return {k: re.sub(rb'"20\d\d-\d\d-\d\dT[\d:.]+Z"', b'"T"', v) for k, v in files.items()}


def blob(files):
    return b"\n".join(files[k] for k in sorted(files))


class Hide(unittest.TestCase):
    def setUp(self):
        self.r = new_rig()
        self.r.run()
        self.note = base.handle_of("N0001")  # on a person of the tree
        self.holder_note = next(o for o in rs.p_fixture() if o["_class"] == "Person" and self.note in (o.get("note_list") or []))
        self.media = base.handle_of("O0001")  # shared, so it stays rendered when one page's reference is hidden
        self.media_holder = next(o for o in rs.p_fixture() if o["_class"] == "Person" and any(x["ref"] == self.media for x in o.get("media_list") or []))

    def run_pass(self):
        out = self.r.run()
        self.assertEqual(out["status"], "rendered", out)
        return out

    def test_a_hidden_note_is_absent_from_every_rendered_key(self):
        before = self.r.site_files()
        self.assertIn(f"note/{self.note}.json", before)
        self.assertIn(self.note.encode(), before[f"person/{self.holder_note['gramps_id']}.json"])
        self.r.store.moderate(f"note:{self.note}", {"class": "Note", "handle": self.note})
        out = self.run_pass()
        after = self.r.site_files()
        self.assertEqual(out["exempt_deletes"], 1)
        self.assertNotIn(f"note/{self.note}.json", after)
        self.assertNotIn(self.note.encode(), blob(after), "no key names the hidden note")
        self.assertEqual(self.r.metrics.count("MassDeleteGuard"), 1, "an exposure-reducing delete alarms however few")
        self.assertNotIn(self.note, json.loads(after[f"person/{self.holder_note['gramps_id']}.json"]).get("note_list", []))
        self.assertTrue(self.r.state()["rendered_seq"] == self.r.table.head_seq())

    def test_a_hidden_mediaref_leaves_the_media_and_the_other_pages_alone(self):
        before = self.r.site_files()
        others = [o for o in rs.p_fixture() if o["_class"] == "Person" and any(x["ref"] == self.media for x in o.get("media_list") or []) and o["handle"] != self.media_holder["handle"]]
        self.r.store.moderate(f"mediaref:{self.media_holder['handle']}:{self.media}", {"class": "Person", "handle": self.media_holder["handle"]})
        self.run_pass()
        after = self.r.site_files()
        gid = self.media_holder["gramps_id"]
        self.assertIn(self.media.encode(), before[f"person/{gid}.json"])
        self.assertNotIn(self.media.encode(), after[f"person/{gid}.json"])
        self.assertIn(f"media/{self.media}.json", after, "the Media itself stays: only this page's reference is hidden")
        # The Media's own file no longer names the page that hid it, and the other pages still show the photo.
        self.assertNotIn(f'"{gid}"'.encode(), after[f"media/{self.media}.json"])
        self.assertIn(f'"{gid}"'.encode(), before[f"media/{self.media}.json"])
        for o in others:
            self.assertIn(self.media.encode(), after[f"person/{o['gramps_id']}.json"])

    def test_a_hidden_media_is_absent_everywhere(self):
        media = base.handle_of("O0001")  # shared by three people
        holders = [o for o in rs.p_fixture() if o["_class"] == "Person" and any(x["ref"] == media for x in o.get("media_list") or [])]
        self.assertGreaterEqual(len(holders), 2)
        before = self.r.site_files()
        self.assertIn(media.encode(), before["media/index.json"])
        self.r.store.moderate(f"media:{media}", {"class": "Media", "handle": media})
        out = self.run_pass()
        after = self.r.site_files()
        self.assertEqual(out["exempt_deletes"], 1)
        self.assertNotIn(f"media/{media}.json", after)
        self.assertNotIn(media.encode(), blob(after), "not in a person, family or event file, media/index.json or search-index.json")
        self.assertNotIn(b"O0001", after["media/index.json"])

    def test_a_marker_wakes_the_pass_and_a_stale_index_does_not_hide_the_item_from_the_overlay(self):
        self.r.table.stale_mod_index = True  # GSI1 has not caught up: only the consistent read of the marker's target sees the hide
        self.r.store.moderate(f"note:{self.note}", {"class": "Note", "handle": self.note})
        self.run_pass()
        self.assertNotIn(f"note/{self.note}.json", self.r.site_files())

    def test_the_media_hide_through_a_stale_index_is_found_through_the_holder_of_its_mediaref(self):
        self.r.table.stale_mod_index = True
        self.r.store.moderate(f"mediaref:{self.media_holder['handle']}:{self.media}", {"class": "Person", "handle": self.media_holder["handle"]})
        self.run_pass()
        self.assertNotIn(self.media.encode(), self.r.site_files()[f"person/{self.media_holder['gramps_id']}.json"])

    def test_unhide_brings_the_item_back(self):
        before = self.r.site_files()
        self.r.store.moderate(f"note:{self.note}", {"class": "Note", "handle": self.note})
        self.run_pass()
        self.r.store.moderate(f"note:{self.note}", {"class": "Note", "handle": self.note}, hidden=False)
        self.run_pass()
        self.assertEqual(stable(self.r.site_files()), stable(before))

    def test_a_question_that_does_not_hide_changes_nothing(self):
        before = self.r.site_files()
        self.r.store.moderate(f"note:{self.note}", {"class": "Note", "handle": self.note}, state="question")
        self.r.table.items[(f"MOD#note:{self.note}", "META")]["hidden"] = False
        self.run_pass()
        self.assertEqual(stable(self.r.site_files()), stable(before))

    def test_a_hide_that_precedes_the_first_pass_is_applied_too(self):
        r = new_rig()
        r.store.moderate(f"note:{self.note}", {"class": "Note", "handle": self.note})
        self.assertEqual(r.run()["status"], "rendered")
        self.assertNotIn(f"note/{self.note}.json", r.site_files())
        self.assertNotIn(self.note.encode(), blob(r.site_files()))

    def test_an_unreadable_overlay_stops_the_pass_and_names_only_a_rule(self):
        self.r.store.moderate(f"note:{self.note}", {"class": "Note", "handle": self.note})
        seq = self.r.state()["rendered_seq"]
        self.r.table.fail_mod_read = True
        with self.assertRaises(errors.RenderFailed) as ctx:
            self.r.run()
        self.assertEqual(str(ctx.exception), errors.RULE_OVERLAY)
        self.assertNotIn("MARKER-7Q", str(ctx.exception))
        self.assertEqual(self.r.state()["rendered_seq"], seq, "the cursor does not move")
        self.assertIn(f"note/{self.note}.json", self.r.site_files(), "nothing is rendered from an overlay that could not be read")
        self.r.table.fail_mod_read = False
        self.assertEqual(self.r.run()["status"], "rendered")
        self.assertNotIn(f"note/{self.note}.json", self.r.site_files())

    def test_the_overlay_is_pure_and_returns_copies(self):
        objects = [dict(o) for o in rs.p_fixture()]
        snapshot = json.dumps(objects, sort_keys=True)
        table = sup.FakeTable()
        table.items[(f"MOD#note:{self.note}", "META")] = {"PK": f"MOD#note:{self.note}", "SK": "META", "entity": "mod", "hidden": True, "open": True, "GSI1PK": "MODQ#open"}
        kept, exempt = overlay.ModOverlay(table).apply(objects)
        self.assertEqual(json.dumps(objects, sort_keys=True), snapshot)
        self.assertEqual(exempt, {f"note/{self.note}.json"})
        self.assertFalse(any(o["handle"] == self.note for o in kept))
        self.assertTrue(all(self.note not in (o.get("note_list") or []) for o in kept))

    def test_a_moderation_marker_is_recorded_for_the_range_only(self):
        view = StoreView(track_after=1)
        view.fold({"seq": 1, "op": "marker", "origin": "moderation", "marker": {"ref": {"class": "Note", "handle": "a"}}})
        view.fold({"seq": 2, "op": "marker", "origin": "moderation", "marker": {"ref": {"class": "Note", "handle": "b"}}})
        view.fold({"seq": 3, "op": "marker", "origin": "desktop", "marker": {"ref": {"class": "Note", "handle": "c"}}})
        view.fold({"seq": 4, "op": "marker", "origin": "moderation"})
        self.assertEqual(view.moderation_refs, [("Note", "b")])


if __name__ == "__main__":
    unittest.main()
