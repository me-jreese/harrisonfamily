"""hfy-sync-render (HFY-TSK-176): the render pass over an in-memory table and buckets.

Covers modes, the diff write, deletes, the mass-delete guard, key ownership, the cursor and the outbox, the push-session guard,
first-live verification and idempotent retries. Standard library only (no boto3). The synthetic tree is the only data.
Run: python3 -m unittest discover gramps/tests/unit
"""

import copy
import hashlib
import json
import unittest

import render_lambda_support as sup
import render_support as rs
from hfy_render import engine, errors


def head_obj(rig, cls, handle):
    return json.loads(rig.table.items[(f"REC#{cls}#{handle}", "HEAD")]["obj_json"])


def handle_of(gramps_id, cls=None):
    for o in rs.p_fixture():
        if o.get("gramps_id") == gramps_id and (cls is None or o["_class"] == cls):
            return o["handle"]
    raise KeyError(gramps_id)


def edit(rig, cls, handle, fn, **kw):
    obj = head_obj(rig, cls, handle)
    fn(obj)
    return rig.store.put(obj, **kw)


def set_note_text(text):
    def apply(obj):
        obj["text"]["string"] = text
        obj["text"]["tags"] = []
    return apply


class Modes(unittest.TestCase):
    def test_off_does_nothing_and_reads_nothing(self):
        rig = sup.Rig("off")
        out = rig.run()
        self.assertEqual(out, {"status": "noop", "mode": "off"})
        self.assertEqual((rig.sync.gets, rig.sync.puts, rig.site.puts, rig.table.reads_log_calls), ([], [], [], 0))
        self.assertEqual(rig.state(), {})

    def test_an_unknown_mode_is_refused(self):
        with self.assertRaises(errors.RenderFailed):
            sup.Rig("sideways").engine()

    def test_live_reproduces_the_golden_site(self):
        rig = sup.Rig("live")
        out = rig.run()
        self.assertEqual(out["status"], "rendered")
        files = rig.site_files()
        self.assertEqual(files, rs.rendered(), "the live site is byte-identical to render_site on P(fixture)")
        self.assertGreater(len(files), 100)
        # ...and the legacy ETL's golden differs only where expected-deltas.json says so.
        places = rs.by_gramps_id("Place")
        excluded = {places[gid]["handle"] for gid in rs.committed_deltas()["excluded_places"]}
        result = rs.deltas.compare(rs.legacy_golden(), files, excluded)
        self.assertEqual(result["unexplained"], [])
        self.assertEqual(result["only_in_render"], [])
        state = rig.state()
        self.assertEqual((state["rendered_seq"], state["mode"]), (rig.table.head_seq(), "live"))
        self.assertNotIn("last_error", state)
        self.assertEqual(rig.manifest("live"), {k: hashlib.sha256(v).hexdigest() for k, v in files.items()})

    def test_shadow_writes_the_shadow_prefix_only_and_no_outbox(self):
        rig = sup.Rig("shadow")
        out = rig.run()
        self.assertEqual(out["status"], "rendered")
        self.assertEqual(rig.site.puts, [])
        self.assertEqual({k[len("render-shadow/"):] for k in rig.sync_store if k.startswith("render-shadow/")}, set(rs.rendered()))
        self.assertIn("render/manifest-shadow.json", rig.sync_store)
        self.assertNotIn("render/manifest-live.json", rig.sync_store)
        self.assertEqual(rig.table.outbox(), {})
        self.assertEqual(rig.state()["mode"], "shadow")
        self.assertIn("render/reports/%d.json" % rig.table.head_seq(), rig.sync_store)

    def test_a_pass_with_nothing_new_writes_nothing(self):
        rig = sup.Rig("live")
        rig.run()
        puts = len(rig.site.puts)
        again = rig.run({"source": "schedule"})
        self.assertEqual(again["reason"], "current")
        self.assertEqual(len(rig.site.puts), puts)
        stream = rig.run({"Records": [{"eventSource": "aws:dynamodb"}]})
        self.assertEqual(stream["reason"], "current")

    def test_an_empty_store_renders_nothing(self):
        rig = sup.Rig("live", store=sup.FakeStore())
        self.assertEqual(rig.run()["reason"], "empty_store")

    def test_flags_count_only_when_exactly_true(self):
        self.assertFalse(engine.parse_event({"allow_mass_delete": "yes"}).allow_mass_delete)
        self.assertTrue(engine.parse_event({"allow_mass_delete": True}).allow_mass_delete)
        self.assertEqual(engine.parse_event({"Records": [{"eventSource": "aws:dynamodb"}]}).source, "stream")
        self.assertEqual(engine.parse_event({"source": "schedule"}).source, "schedule")


class DiffWrite(unittest.TestCase):
    def test_only_keys_whose_sha256_changed_are_written(self):
        rig = sup.Rig("live")
        rig.run()
        before = rig.site_files()
        edit(rig, "Note", handle_of("N0001"), set_note_text("A changed fixture sentence."))
        rig.site.puts.clear()
        out = rig.run()
        after = rig.site_files()
        changed = {k for k in after if before.get(k) != after[k]}
        self.assertTrue(changed)
        self.assertEqual(set(rig.site.puts), changed)
        self.assertEqual(len(rig.site.puts), len(changed), "no key is written twice")
        self.assertEqual(out["written"], len(changed))
        self.assertEqual(out["unchanged"], len(after) - len(changed))
        self.assertEqual(rig.site.deletes, [])

    def test_a_removed_person_deletes_only_what_left_the_desired_set(self):
        rig = sup.Rig("live")
        rig.run()
        before = rig.site_files()
        # Foreign keys: legacy files the renderer never wrote, under the data prefixes. They must survive.
        rig.site.objects["person/Z0001.json"] = b"{}"
        rig.site.objects["note/legacy-note.json"] = b"{}"
        rig.store.remove("Person", handle_of("I0026"))
        out = rig.run()
        after = rig.site_files()
        gone = {k for k in before if k not in sup.fresh_render(rig)}
        self.assertIn("person/I0026.json", gone)
        self.assertEqual(set(rig.site.deletes), gone)
        self.assertEqual(out["deleted"], len(gone))
        self.assertIn("person/Z0001.json", after)
        self.assertIn("note/legacy-note.json", after)

    def test_the_first_live_pass_reports_foreign_keys_and_deletes_none(self):
        rig = sup.Rig("live")
        rig.site.objects["person/Z0001.json"] = b"{}"
        rig.site.objects["family/legacyfam.json"] = b"{}"
        out = rig.run()
        self.assertEqual(out["foreign"], 2)
        self.assertEqual(rig.site.deletes, [])
        report = json.loads(rig.sync_store["render/reports/%d.json" % rig.table.head_seq()])
        self.assertEqual(report["foreign"], ["family/legacyfam.json", "person/Z0001.json"])
        self.assertEqual(rig.state()["foreign_keys"], 2)

    def test_prune_foreign_deletes_reviewed_foreign_keys_only(self):
        rig = sup.Rig("live")
        rig.site.objects["person/Z0001.json"] = b"{}"
        for protected in ("person/index.html", "person/graph.json", "media/aaaabbbbccccddddeeee.jpg", "media/faces/I0001-abcd1234.webp", "media/tree_I0001.svg"):
            rig.site.objects[protected] = b"x"
        rig.run()
        out = rig.run({"prune_foreign": True})
        self.assertEqual(rig.site.deletes, ["person/Z0001.json"])
        self.assertEqual(out["pruned"], 1)
        for protected in ("person/index.html", "person/graph.json", "media/aaaabbbbccccddddeeee.jpg", "media/faces/I0001-abcd1234.webp", "media/tree_I0001.svg"):
            self.assertIn(protected, rig.site.objects)

    def test_a_prefix_the_role_cannot_list_is_reported_not_fatal(self):
        rig = sup.Rig("live")
        rig.site.deny_list_prefixes = {"media"}
        rig.run()
        report = json.loads(rig.sync_store["render/reports/%d.json" % rig.table.head_seq()])
        self.assertEqual(report["foreign_unlisted_prefixes"], ["media"])

    def test_threaded_writes_give_the_same_site(self):
        rig = sup.Rig("live", workers=4)
        rig.run()
        self.assertEqual(rig.site_files(), rs.rendered())
        self.assertEqual(len(rig.site.puts), len(set(rig.site.puts)))


class KeyOwnership(unittest.TestCase):
    PROTECTED = ["person/index.html", "person/graph.json", "person/search-store.json", "media/aaaabbbbccccddddeeee.jpg",
                 "media/faces/I0001-abcd1234.webp", "media/tree_I0001.svg", "media/.staging/x/y", "uploads/posts/a/photo.jpg", "person/", "person/a/b.json"]

    def test_the_ownership_rule(self):
        from hfy_render.keys import is_owned_key

        for key in self.PROTECTED:
            self.assertFalse(is_owned_key(key), key)
        for key in ("person/I0001.json", "person/index.json", "person/search-index.json", "family/abc123.json", "event/e.json",
                    "note/n.json", "place/index.json", "place/p.json", "media/index.json", "media/abc.json"):
            self.assertTrue(is_owned_key(key), key)

    def test_a_tampered_manifest_never_gets_a_protected_key_deleted(self):
        rig = sup.Rig("live")
        rig.run()
        for key in self.PROTECTED:
            rig.site.objects[key] = b"keep"
        manifest = rig.manifest("live")
        manifest.update({k: "0" * 64 for k in self.PROTECTED})
        rig.sync_store["render/manifest-live.json"] = json.dumps({"version": 1, "mode": "live", "seq": 1, "keys": manifest}).encode()
        edit(rig, "Note", handle_of("N0001"), set_note_text("Another changed sentence."))
        rig.run()
        self.assertEqual(rig.site.deletes, [])
        for key in self.PROTECTED:
            self.assertEqual(rig.site.objects[key], b"keep")
        self.assertFalse(set(self.PROTECTED) & set(rig.manifest("live")), "the tampered keys are dropped from the manifest, not adopted")

    def test_the_writer_refuses_a_protected_key(self):
        rig = sup.Rig("live")
        eng = rig.engine()
        for key in self.PROTECTED:
            with self.assertRaises(errors.ProtectedKey):
                eng._write_one(rig.site, key, b"x", "0" * 64, False)
            with self.assertRaises(errors.ProtectedKey):
                eng._delete_one(rig.site, key)
        self.assertEqual((rig.site.puts, rig.site.deletes), ([], []))

    def test_the_site_run_never_touches_the_protected_keys(self):
        rig = sup.Rig("live")
        for key in self.PROTECTED:
            rig.site.objects[key] = b"keep"
        rig.run()
        rig.store.remove("Person", handle_of("I0026"))
        rig.run()
        self.assertFalse(set(rig.site.puts) & set(self.PROTECTED))
        self.assertFalse(set(rig.site.deletes) & set(self.PROTECTED))
        for key in self.PROTECTED:
            self.assertEqual(rig.site.objects[key], b"keep")


class MassDeleteGuard(unittest.TestCase):
    def persons_to_delete(self, n):
        ids = ["I0016", "I0017", "I0018", "I0019", "I0020", "I0021", "I0022", "I0025", "I0004", "I0005", "I0006", "I0007", "I0026"]
        return ids[:n]

    def test_more_than_the_threshold_refuses_every_delete_and_holds_the_cursor(self):
        rig = sup.Rig("live")
        rig.run()
        seq_before = rig.state()["rendered_seq"]
        manifest_size = len(rig.manifest("live"))
        for gid in self.persons_to_delete(13):
            rig.store.remove("Person", handle_of(gid))
        out = rig.run()
        self.assertEqual(out["status"], "blocked")
        self.assertGreater(out["refused_deletes"], max(10, 0.10 * manifest_size))
        self.assertEqual(rig.site.deletes, [])
        self.assertEqual(rig.metrics.count("MassDeleteGuard"), 1)
        state = rig.state()
        self.assertEqual(state["rendered_seq"], seq_before)
        self.assertEqual(state["last_error"], "RenderFailed:guard.mass_delete")
        self.assertEqual(len(rig.table.outbox()), 1, "no outbox item for the blocked range")
        self.assertEqual(len(rig.manifest("live")), manifest_size, "refused keys stay owned")
        # the next scheduled pass retries and alarms again
        again = rig.run()
        self.assertEqual(again["status"], "blocked")
        self.assertEqual(rig.metrics.count("MassDeleteGuard"), 2)

    def test_the_operator_override_deletes_and_advances(self):
        rig = sup.Rig("live")
        rig.run()
        for gid in self.persons_to_delete(13):
            rig.store.remove("Person", handle_of(gid))
        rig.run()
        out = rig.run({"allow_mass_delete": True})
        self.assertEqual(out["status"], "rendered")
        self.assertGreaterEqual(out["deleted"], 13)
        self.assertEqual(rig.state()["rendered_seq"], rig.table.head_seq())
        self.assertNotIn("last_error", rig.state())
        self.assertNotIn("person/I0016.json", rig.site_files())

    def test_the_threshold_is_max_10_and_10_percent_of_the_manifest(self):
        from hfy_render.view import StoreView

        eng = sup.Rig("live").engine()

        def plan(manifest_size, deletes, allow=False):
            base = {f"note/n{i:04d}.json": "a" * 64 for i in range(manifest_size)}
            desired = {k: v for k, v in list(base.items())[deletes:]}
            req = engine.Request(allow_mass_delete=allow)
            return eng._plan(req, StoreView(), {}, desired, {}, base, None, False, False, set())

        for size, limit in ((50, 10), (100, 10), (200, 20), (1000, 100)):
            ok = plan(size, limit)
            self.assertEqual((len(ok.deletes), ok.refused), (limit, []), (size, limit))
            tripped = plan(size, limit + 1)
            self.assertEqual((tripped.deletes, len(tripped.refused)), ([], limit + 1), (size, limit + 1))
            override = plan(size, limit + 1, allow=True)
            self.assertEqual((len(override.deletes), override.refused), (limit + 1, []))

    def test_withdrawn_people_are_exempt_and_rendered_with_no_override(self):
        rig = sup.Rig("live")
        rig.run()
        ids = ["I0016", "I0017", "I0018", "I0019", "I0020", "I0021", "I0022", "I0025", "I0004", "I0005", "I0006", "I0007", "I0008", "I0023", "I0024"]
        for gid in ids:
            rig.store.remove("Person", handle_of(gid), op="withdraw", reason="private", origin="admin")
        out = rig.run()
        self.assertEqual(out["status"], "rendered", "15 withdrawn people are rendered with no override")
        for gid in ids:
            self.assertNotIn(f"person/{gid}.json", rig.site_files())
        self.assertGreaterEqual(out["deleted"], 15)
        self.assertEqual(out["refused_deletes"], 0)
        self.assertGreaterEqual(out["exempt_deletes"], 15)
        self.assertEqual(rig.metrics.count("MassDeleteGuard"), 1, "the exempt deletes still alarm")
        box = rig.table.outbox()[sup.seq_key(rig.table.head_seq())]
        self.assertEqual(set(box["deleted_people"]), set(ids))
        self.assertEqual(rig.state()["rendered_seq"], rig.table.head_seq())

    def test_a_moderation_hide_is_exempt_too(self):
        hidden_notes = [o["handle"] for o in rs.p_fixture() if o["_class"] == "Note" and o["gramps_id"].startswith("N9") and o["gramps_id"] != "N9101"]

        class Overlay:
            hide = set()

            def apply(self, objects):
                kept = [o for o in objects if o["handle"] not in self.hide]
                return kept, {f"note/{h}.json" for h in self.hide}

        overlay = Overlay()
        rig = sup.Rig("live", overlay=overlay)
        rig.run()
        self.assertTrue(all(f"note/{h}.json" in rig.site_files() for h in hidden_notes))
        overlay.hide = set(hidden_notes)
        rig.marker = rig.store.marker()
        out = rig.run()
        self.assertEqual(out["status"], "rendered")
        self.assertEqual(out["exempt_deletes"], len(hidden_notes))
        self.assertTrue(all(f"note/{h}.json" not in rig.site_files() for h in hidden_notes))
        self.assertEqual(rig.metrics.count("MassDeleteGuard"), 1 if len(hidden_notes) > 10 else 0)


class Cursor(unittest.TestCase):
    def test_an_abandoned_push_session_is_rendered_through_the_schedule(self):
        rig = sup.Rig("live")
        rig.run()
        edit(rig, "Note", handle_of("N0001"), set_note_text("A pushed sentence."))
        rig.store.open_session("sess1", rig.clock.now)
        rig.clock.advance(5 * 60)
        young = rig.run({"Records": [{"eventSource": "aws:dynamodb"}]})
        self.assertEqual((young["status"], young["reason"]), ("skipped", "push_session_open"))
        self.assertEqual(rig.state()["rendered_seq"], rig.table.head_seq() - 1, "the cursor does not move while the session is open")
        rig.clock.advance(6 * 60)  # 11 minutes old: abandoned
        out = rig.run({"source": "schedule"})
        self.assertEqual(out["status"], "rendered")
        self.assertEqual(rig.state()["rendered_seq"], rig.table.head_seq())

    def test_a_closed_or_expired_session_does_not_hold_the_render(self):
        for state, age in (("complete", 60), ("aborted", 60), ("open", 8 * 86400)):
            rig = sup.Rig("live")
            rig.store.open_session("s", rig.clock.now - __import__("datetime").timedelta(seconds=age), state=state)
            self.assertEqual(rig.run()["status"], "rendered", (state, age))

    def test_a_missing_session_item_does_not_hold_the_render(self):
        rig = sup.Rig("live")
        rig.table.items[("SYNC#HEAD", "META")]["open_session"] = "gone"
        self.assertEqual(rig.run()["status"], "rendered")

    def test_a_failed_write_leaves_the_cursor_and_a_retry_finishes_without_repeating(self):
        rig = sup.Rig("live")
        rig.run()
        edit(rig, "Place", handle_of("P0003"), lambda o: o.update(name={**o["name"], "value": "Sample Farm Renamed"}))
        edit(rig, "Note", handle_of("N0001"), set_note_text("A retried sentence."))
        before = rig.site_files()
        rig_desired = sup.fresh_render(rig)
        rig.site.puts.clear()
        rig.site.fail_put_after = 2
        with self.assertRaises(errors.RenderFailed) as ctx:
            rig.run()
        self.assertEqual(str(ctx.exception), "pass.failed")
        self.assertEqual(rig.state()["rendered_seq"], rig.table.head_seq() - 2, "the cursor did not advance")
        self.assertEqual(len(rig.table.outbox()), 1, "no outbox item for the failed range")
        done = list(rig.site.puts)
        self.assertEqual(len(done), 2)
        stale = {k for k, v in rig.manifest("live").items() if v != hashlib.sha256(rig_desired[k]).hexdigest()}
        self.assertTrue(stale, "keys not yet written keep their old hash, so the next pass rewrites them")
        rig.site.fail_put_after = None
        rig.site.puts.clear()
        out = rig.run()
        self.assertEqual(out["status"], "rendered")
        self.assertFalse(set(done) & set(rig.site.puts), "the retry writes only what the first attempt did not")
        after = rig.site_files()
        self.assertEqual(set(done) | set(rig.site.puts), {k for k in after if before.get(k) != after[k]})
        self.assertEqual(len(rig.table.outbox()), 2, "exactly one outbox item for the range")
        self.assertEqual(rig.state()["rendered_seq"], rig.table.head_seq())
        self.assertEqual(rig.run()["reason"], "current")
        self.assertEqual(len(rig.table.outbox()), 2)

    def test_a_failed_commit_does_not_notify_and_the_retry_notifies_once(self):
        rig = sup.Rig("live")
        rig.run()
        edit(rig, "Note", handle_of("N0001"), set_note_text("Commit retry."))
        rig.table.fail_commit = True
        with self.assertRaises(errors.RenderFailed):
            rig.run()
        self.assertEqual(len(rig.table.outbox()), 1)
        rig.table.fail_commit = False
        rig.site.puts.clear()
        rig.run()
        self.assertEqual(rig.site.puts, [], "the files were already written; the retry only advances")
        self.assertEqual(len(rig.table.outbox()), 2)

    def test_a_concurrent_cursor_move_is_a_state_conflict(self):
        rig = sup.Rig("live")
        rig.run()
        edit(rig, "Note", handle_of("N0001"), set_note_text("Raced."))
        table = rig.table
        original = table.commit_pass

        def raced(expect, fields, remove, outbox):
            table.items[("SYNC#RENDER", "STATE")]["rendered_seq"] = 999  # another writer got there first
            return original(expect, fields, remove, outbox)

        table.commit_pass = raced
        with self.assertRaises(errors.RenderFailed) as ctx:
            rig.run()
        self.assertEqual(ctx.exception.rule, errors.RULE_STATE_CONFLICT)

    def test_a_time_budget_stops_the_writes_and_the_next_pass_resumes(self):
        calls = {"n": 0}

        def remaining():
            calls["n"] += 1
            return 5_000 if calls["n"] > 6 else 10 ** 9

        rig = sup.Rig("live", remaining_ms=remaining)
        with self.assertRaises(errors.RenderFailed) as ctx:
            rig.run()
        self.assertEqual(ctx.exception.rule, errors.RULE_TIMEOUT)
        written = len(rig.site.puts)
        self.assertTrue(0 < written < len(rs.rendered()))
        self.assertNotIn("rendered_seq", rig.state())
        self.assertIn("first_live_attempt", rig.state())
        first = set(rig.site.puts)
        rig.remaining_ms = None
        rig.site.puts.clear()
        rig.site.heads.clear()
        out = rig.run()
        self.assertEqual(out["status"], "rendered")
        self.assertFalse(first & set(rig.site.puts), "the first live pass resumes from its own manifest instead of starting over")
        self.assertEqual(first | set(rig.site.puts), set(rs.rendered()))
        self.assertEqual(sorted(rig.site.heads), sorted(rig.site.puts), "the resumed keys are verified too")
        self.assertEqual(rig.site_files(), rs.rendered())
        self.assertNotIn("first_live_attempt", rig.state())
        self.assertEqual(rig.state()["mode"], "live")

    def test_a_stale_first_live_attempt_in_the_manifest_is_never_trusted(self):
        rig = sup.Rig("live")
        rig.run()
        # live -> shadow -> live: the manifest of the earlier live period must not be mistaken for a resumable attempt
        rig.run(mode="shadow")
        rig.site.puts.clear()
        rig.run(mode="live")
        self.assertEqual(len(rig.site.puts), len(rs.rendered()))


class FirstLivePass(unittest.TestCase):
    def test_it_ignores_every_manifest_writes_every_key_and_verifies_each(self):
        import hashlib

        rig = sup.Rig("live")
        desired = {k: hashlib.sha256(v).hexdigest() for k, v in rs.rendered().items()}
        # a manifest that claims everything is already live (as the shadow pass or an old live period might have left it)
        for mode in ("live", "shadow"):
            rig.sync_store["render/manifest-%s.json" % mode] = json.dumps({"version": 1, "mode": mode, "seq": 1, "keys": desired}).encode()
        rig.run()
        self.assertEqual(sorted(rig.site.puts), sorted(desired))
        self.assertEqual(sorted(rig.site.heads), sorted(desired), "each written key is verified with a checksum HeadObject")
        # the second pass trusts the manifest again
        edit(rig, "Note", handle_of("N0001"), set_note_text("After the first pass."))
        rig.site.puts.clear()
        rig.site.heads.clear()
        rig.run()
        self.assertLess(len(rig.site.puts), 10)
        self.assertEqual(rig.site.heads, [])

    def test_an_unreadable_manifest_stops_a_normal_pass_but_not_the_first_live_pass(self):
        rig = sup.Rig("live")
        rig.sync_store["render/manifest-live.json"] = b"not json"
        self.assertEqual(rig.run()["status"], "rendered")
        rig.sync_store["render/manifest-live.json"] = b"{"
        edit(rig, "Note", handle_of("N0001"), set_note_text("After a bad manifest."))
        with self.assertRaises(errors.RenderFailed) as ctx:
            rig.run()
        self.assertEqual(ctx.exception.rule, "manifest.corrupt")

    def test_a_checksum_that_does_not_match_fails_the_pass(self):
        rig = sup.Rig("live")
        rig.site.lie_checksum = True
        with self.assertRaises(errors.RenderFailed) as ctx:
            rig.run()
        self.assertEqual(ctx.exception.rule, errors.RULE_CHECKSUM)
        self.assertNotIn("rendered_seq", rig.state())
        self.assertEqual(rig.state()["last_error"], "RenderFailed:write.checksum_mismatch")

    def test_manifests_are_scoped_by_mode(self):
        rig = sup.Rig("shadow")
        rig.run()
        shadow = rig.manifest("shadow")
        self.assertEqual(set(shadow), set(rs.rendered()))
        self.assertIsNone(rig.manifest("live"))
        live = sup.Rig("live", store=rig.store)
        live.sync_store.update(rig.sync_store)  # the same sync bucket, shadow manifest present
        live.table = rig.table
        live.run()
        self.assertEqual(len(live.site.puts), len(rs.rendered()), "live does not inherit the shadow pass")
        self.assertEqual(live.state()["mode"], "live")
        self.assertEqual(set(live.manifest("live")), set(rs.rendered()))
        self.assertEqual(live.manifest("shadow"), shadow, "the shadow manifest is untouched by the live pass")

    def test_going_back_to_live_after_off_is_a_first_pass_again(self):
        rig = sup.Rig("live")
        rig.run()
        rig.run(mode="shadow")
        self.assertEqual(rig.state()["mode"], "shadow")
        rig.site.puts.clear()
        rig.run(mode="live")
        self.assertEqual(len(rig.site.puts), len(rs.rendered()))


class Outbox(unittest.TestCase):
    def box(self, rig):
        return rig.table.outbox()[sup.seq_key(rig.table.head_seq())]

    def test_the_first_pass_is_a_silent_baseline(self):
        rig = sup.Rig("live")
        rig.run()
        box = self.box(rig)
        self.assertTrue(box["baseline"])
        self.assertEqual((box["changed_people"], box["deleted_people"]), ([], []))
        self.assertEqual((box["seq_from"], box["seq_to"]), (1, rig.table.head_seq()))

    def test_a_note_maps_to_the_person_who_holds_it(self):
        rig = sup.Rig("live")
        rig.run()
        edit(rig, "Note", handle_of("N0001"), set_note_text("A person note changed."), origin="self", principal="p-member")
        rig.run()
        box = self.box(rig)
        self.assertFalse(box["baseline"])
        self.assertEqual(box["changed_people"], ["I0012"])
        self.assertEqual(box["seq_from"], box["seq_to"])
        self.assertEqual((box["principals"], box["origins"]), (["p-member"], ["self"]))
        self.assertGreater(box["ttl"], 0)

    def test_a_family_note_maps_to_every_member_of_the_family(self):
        rig = sup.Rig("live")
        rig.run()
        family = handle_of("F0001")
        expected = {o["gramps_id"] for o in rs.p_fixture()  # every person that holds the family (the store's backrefs of it)
                    if o["_class"] == "Person" and family in (o.get("family_list", []) + o.get("parent_family_list", []))}
        edit(rig, "Note", handle_of("N0004"), set_note_text("A family note changed."))
        rig.run()
        self.assertEqual(set(self.box(rig)["changed_people"]), expected)
        self.assertGreaterEqual(len(expected), 7)

    def test_a_place_maps_through_its_events_to_their_people(self):
        rig = sup.Rig("live")
        rig.run()
        edit(rig, "Place", handle_of("P0003"), lambda o: o["name"].update(value="Sample Farm Two"))
        rig.run()
        self.assertEqual(set(self.box(rig)["changed_people"]), {"I0001", "I0002"})

    def test_a_deleted_person_is_listed_and_the_neighbours_are_changed(self):
        rig = sup.Rig("live")
        rig.run()
        rig.store.remove("Person", handle_of("I0026"))
        rig.run()
        box = self.box(rig)
        self.assertEqual(box["deleted_people"], ["I0026"])
        self.assertNotIn("I0026", box["changed_people"])

    def test_a_marker_only_range_changes_nobody(self):
        rig = sup.Rig("live")
        rig.run()
        rig.store.marker()
        rig.run()
        box = self.box(rig)
        self.assertEqual((box["changed_people"], box["deleted_people"], box["entries"]), ([], [], 0))

    def test_shadow_passes_write_no_outbox(self):
        rig = sup.Rig("shadow")
        rig.run()
        edit(rig, "Note", handle_of("N0001"), set_note_text("Shadow only."))
        rig.run()
        self.assertEqual(rig.table.outbox(), {})

    def test_the_outbox_lists_are_capped(self):
        rig = sup.Rig("live")
        rig.run()
        from hfy_render import engine as eng

        old = eng.OUTBOX_LIST_CAP
        eng.OUTBOX_LIST_CAP = 1
        try:
            edit(rig, "Note", handle_of("N0004"), set_note_text("A family note, again."))
            rig.run()
        finally:
            eng.OUTBOX_LIST_CAP = old
        box = self.box(rig)
        self.assertEqual(len(box["changed_people"]), 1)
        self.assertTrue(box["truncated"])
        self.assertGreater(box["changed_count"], 1)


class NoGrampsId(unittest.TestCase):
    def test_a_person_without_an_id_gets_no_file_and_no_index_entry_until_one_is_assigned(self):
        rig = sup.Rig("live")
        obj = copy.deepcopy([o for o in rs.p_fixture() if o.get("gramps_id") == "I0026"][0])
        obj["handle"] = "feedfacefeedfacefeedface0001"
        obj["gramps_id"] = ""
        obj["primary_name"]["first_name"] = "Ivy"
        rig.store.put(obj)
        rig.run()
        files = rig.site_files()
        golden = rs.rendered()
        self.assertEqual(set(files), set(golden))
        index_files = {"person/index.json", "person/search-index.json"}  # generatedAt is the new head's time
        self.assertEqual({k: v for k, v in files.items() if k not in index_files}, {k: v for k, v in golden.items() if k not in index_files},
                         "an ID-less person changes nothing on the site")
        index = json.loads(files["person/index.json"])
        self.assertNotIn("Ivy", json.dumps(index))
        self.assertFalse([k for k in files if "feedfacefeedfacefeedface0001" in k])
        obj["gramps_id"] = "I9999"
        rig.store.put(obj)
        rig.run()
        files = rig.site_files()
        self.assertIn("person/I9999.json", files)
        self.assertIn("I9999", json.dumps(json.loads(files["person/index.json"])))
        self.assertIn("I9999", json.dumps(json.loads(files["person/search-index.json"])))


class Reconcile(unittest.TestCase):
    def test_a_matching_store_raises_nothing(self):
        rig = sup.Rig("live")
        out = rig.run()
        self.assertEqual(out["reconcile_mismatches"], 0)
        self.assertEqual(rig.metrics.count("HeadMismatch"), 0)
        self.assertIn("last_reconcile_at", rig.state())

    def test_a_head_that_differs_from_the_view_is_a_head_mismatch(self):
        rig = sup.Rig("live")
        rig.run()
        rig.clock.advance(25 * 3600)
        head = rig.table.items[(f"REC#Person#{handle_of('I0003')}", "HEAD")]
        head["hash"] = "f" * 64  # the head claims different content from the log's latest entry
        head2 = rig.table.items[(f"REC#Note#{handle_of('N0001')}", "HEAD")]
        head2["version"] += 3
        out = rig.run({"source": "schedule"})
        self.assertEqual(out["status"], "reconciled")
        self.assertEqual(out["reconcile_mismatches"], 2)
        self.assertEqual(rig.metrics.count("HeadMismatch"), 2)

    def test_it_runs_at_most_daily_unless_asked(self):
        rig = sup.Rig("live")
        rig.run()
        rig.table.items[(f"REC#Person#{handle_of('I0003')}", "HEAD")]["hash"] = "e" * 64
        rig.clock.advance(3600)
        self.assertEqual(rig.run({"source": "schedule"})["reason"], "current")
        self.assertEqual(rig.metrics.count("HeadMismatch"), 0)
        self.assertEqual(rig.run({"reconcile": True})["reconcile_mismatches"], 1)

    def test_a_head_newer_than_the_view_is_not_compared(self):
        rig = sup.Rig("live")
        rig.run()
        rig.table.items[(f"REC#Person#{handle_of('I0003')}", "HEAD")].update({"seq": rig.table.head_seq() + 5, "hash": "d" * 64})
        rig.clock.advance(25 * 3600)
        self.assertEqual(rig.run({"source": "schedule"})["reconcile_mismatches"], 0)

    def test_a_head_missing_from_the_gsi_is_confirmed_with_a_consistent_read(self):
        rig = sup.Rig("live")
        rig.run()
        rig.clock.advance(25 * 3600)
        original = rig.table.query_heads

        def lagging(cls):
            for item in original(cls):
                if item["handle"] != handle_of("I0003"):
                    yield item  # the GSI has not caught up with this head yet

        rig.table.query_heads = lagging
        self.assertEqual(rig.run({"source": "schedule"})["reconcile_mismatches"], 0, "the base-table read finds it intact")


if __name__ == "__main__":
    unittest.main()
