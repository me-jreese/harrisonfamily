"""Catalog rows S13 and S15 of the render Lambda (HFY-TSK-150, review SI-21; error catalog sync.md section 17).

Both are a store that disagrees with itself, which the GID guard and the hash on every head make impossible in normal use. The renderer
does not stop for either: it renders what it can, keeps the last good file for what it cannot, and raises the head-mismatch alarm
(`HeadMismatch`, counts only). Standard library only; the synthetic tree is the only data.
"""

import copy
import re
import unittest

import render_lambda_support as sup
from hfy_render.aws import seq_key
from test_render_lambda import handle_of, head_obj, set_note_text, edit


def without_times(files):
    """The site with the generation time (the newest log entry's time, which moves with every pass) blanked out."""
    return {k: re.sub(rb"\d{4}-\d\d-\d\dT[\d:.]+Z", b"T", v) for k, v in files.items()}


class TwoHeadsOneGrampsId(unittest.TestCase):
    """S13: the GID guard stops a second live head from taking an ID, so this is a store defect; the site still has to render."""

    def duplicate(self, rig, handle):
        original = head_obj(rig, "Person", handle_of("I0003"))
        twin = copy.deepcopy(original)
        twin["handle"] = handle
        twin["primary_name"]["first_name"] = "Twin"
        rig.store.put(twin)
        return original

    def test_s13_two_live_heads_with_one_gramps_id_render_the_first_by_handle_order_and_raise_the_alarm(self):
        rig = sup.Rig("live")
        rig.run()
        self.assertEqual(rig.metrics.count("HeadMismatch"), 0)
        before = rig.site_files()
        self.duplicate(rig, "z" * 28)                       # sorts after the real person's handle
        out = rig.run()
        self.assertEqual(out["status"], "rendered")
        self.assertEqual(rig.metrics.count("HeadMismatch"), 1)
        self.assertEqual(rig.site_files()["person/I0003.json"], before["person/I0003.json"], "the first handle still owns the file")
        self.assertNotIn(b"Twin", rig.site_files()["person/I0003.json"])

    def test_s13_a_twin_that_sorts_first_takes_the_file_and_the_alarm_is_raised_again_on_each_pass(self):
        rig = sup.Rig("live")
        rig.run()
        self.duplicate(rig, "0" * 28)                       # sorts before it
        rig.run()
        self.assertIn(b"Twin", rig.site_files()["person/I0003.json"], "the first handle by (gramps_id, handle) order renders")
        self.assertEqual(rig.metrics.count("HeadMismatch"), 1)
        edit(rig, "Note", handle_of("N0001"), set_note_text("A later, unrelated edit."))
        rig.run()
        self.assertEqual(rig.metrics.count("HeadMismatch"), 2, "the condition holds, so every pass that reads the store says so")


class LogEntryThatDoesNotHash(unittest.TestCase):
    """S15: a log entry whose object is not the one its hash covers is skipped, the pass goes on, and the alarm is raised."""

    def tampered(self, rig):
        note = handle_of("N0001")
        seq = edit(rig, "Note", note, set_note_text("The text the entry should have held."))
        entry = rig.table.items[("SYNC#LOG", seq_key(seq))]
        entry["obj_json"] = entry["obj_json"].replace("should have held", "was changed in the store")
        return note, seq

    def test_s15_a_log_entry_whose_object_does_not_hash_to_its_hash_is_skipped_and_raises_the_alarm(self):
        rig = sup.Rig("live")
        rig.run()
        before = rig.site_files()
        _note, seq = self.tampered(rig)
        out = rig.run()
        self.assertEqual(out["status"], "rendered", "the pass is not stopped")
        self.assertEqual(rig.state()["rendered_seq"], seq, "and the cursor moved past the entry")
        self.assertEqual(rig.metrics.count("HeadMismatch"), 1)
        after = rig.site_files()
        self.assertEqual(without_times(after), without_times(before), "the object kept its last good version: the site is as it was")
        self.assertNotIn(b"was changed in the store", b"".join(after.values()))

    def test_s15_a_good_entry_after_it_restores_the_object_and_ends_the_alarm(self):
        rig = sup.Rig("live")
        rig.run()
        note, _seq = self.tampered(rig)
        rig.run()
        self.assertEqual(rig.metrics.count("HeadMismatch"), 1)
        edit(rig, "Note", note, set_note_text("The operator's corrected text."), principal="p-operator")
        out = rig.run()
        self.assertEqual(out["status"], "rendered")
        self.assertEqual(rig.metrics.count("HeadMismatch"), 1, "no new alarm: the newest entry of the object hashes")
        self.assertIn(b"The operator's corrected text.", b"".join(rig.site_files().values()))


if __name__ == "__main__":
    unittest.main()
