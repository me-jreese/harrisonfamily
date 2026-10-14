"""hfy-sync-render (HFY-TSK-176): the privacy re-check of every output, and the rule that no failure carries a message.

A planted birth date or contact value in a store object must block exactly the output files that carry it (the site keeps the last
good copy), emit RenderPrivacyBlock, and appear nowhere: not on the site, not in the manifest or report, not in the render state, not in
a log line, not in an exception. The planted values are synthetic.
"""

import json
import logging
import unittest

import render_lambda_support as sup
import render_support as rs
from hfy_render import errors
from hfy_render.privacy import PrivacyChecker

PLANTED_DATE_TEXT = "14 February 1840"
PLANTED_YEAR_FRAGMENT = "February"
PLANTED_PHONE = "415-555-0136"


def handle_of(gramps_id):
    return [o for o in rs.p_fixture() if o.get("gramps_id") == gramps_id][0]["handle"]


def head_obj(rig, cls, handle):
    return json.loads(rig.table.items[(f"REC#{cls}#{handle}", "HEAD")]["obj_json"])


def plant_date(obj):
    obj["date"] = {**obj["date"], "dateval": [0, 0, 1840, False], "text": PLANTED_DATE_TEXT, "sortval": 0}


def plant_phone(obj):
    obj["primary_name"]["first_name"] = "Cedar " + PLANTED_PHONE


def everything_stored(rig):
    parts = [json.dumps({"%s|%s" % k: v for k, v in rig.table.items.items()}, default=str, sort_keys=True)]
    parts += [v.decode("utf-8", "replace") for v in rig.sync_store.values()]
    parts += [v.decode("utf-8", "replace") for v in rig.site.objects.values()]
    return "\n".join(parts)


class Checker(unittest.TestCase):
    def setUp(self):
        self.c = PrivacyChecker()

    def check(self, doc):
        return self.c.check(json.dumps(doc).encode())

    def test_a_clean_rendered_site_has_no_violation(self):
        for key, body in rs.rendered().items():
            self.assertEqual(self.c.check(body), [], key)

    def test_the_structural_rules(self):
        self.assertEqual(self.check({"a": [{"sortValue": 1}]}), [errors.RULE_SORT_VALUE])
        self.assertEqual(self.check({"sortval": 2457000}), [errors.RULE_SORT_VALUE])
        self.assertEqual(self.check({"media": {"sourcePath": "/home/x/y.jpg"}}), [errors.RULE_SOURCE_PATH])
        for text in ("14 February 1840", "Feb 1840", "1840-02-14", "2/14/1840", "March 3", "1840/02"):
            self.assertIn(errors.RULE_DATE_TEXT, self.check({"events": [{"date": {"text": text, "year": 1840}}]}), text)
        for text in ("", "1840", "about 1840", "between 1830 and 1840"):
            self.assertEqual(self.check({"date": {"text": text, "year": 1840}}), [], text)

    def test_the_detectors_run_on_every_free_string(self):
        self.assertIn("privacy.detector.phone", self.check({"displayName": "Cedar " + PLANTED_PHONE}))
        self.assertIn("privacy.detector.email", self.check({"x": {"y": ["write to a.b@example.org"]}}))
        self.assertTrue(self.check({"note": "born on the 14th of February 1840"}))
        self.assertTrue(self.check({"note": "visit 12 Example Street"}))

    def test_identifiers_and_coordinates_are_not_free_text(self):
        handle = "868977894a87ffaf7143ff092c63"
        self.assertEqual(self.check({"handle": handle, "children": [{"handle": handle}], "checksum": "a" * 64, "s3Key": "media/%s.jpg" % handle,
                                     "generatedAt": "2000-01-01T00:00:00.000Z"}), [])
        self.assertEqual(self.check({"place": {"latitude": "12.345678", "longitude": "-23.456789"}}), [])
        self.assertTrue(self.check({"place": {"latitude": "415 555 0136"}}), "a phone number in a coordinate is still scanned")

    def test_identifier_fields_are_validated_by_shape_not_skipped(self):
        shape = errors.RULE_IDENTIFIER_SHAPE
        handle = "868977894a87ffaf7143ff092c63"
        good = {"handle": handle, "grampsId": "I0004", "checksum": "a" * 64, "s3Key": "media/%s.jpg" % handle, "mime": "image/jpeg",
                "generatedAt": "2000-01-01T00:00:00.000Z"}
        self.assertEqual(self.check(good), [])
        for key, value in (("grampsId", "4155550136"), ("grampsId", "I4155550136"), ("grampsId", "415-555-0136"), ("grampsId", "I0004\n"),
                           ("grampsId", "i0004"), ("handle", "415-555-0136"), ("handle", "short"), ("handle", handle + "\n"),
                           ("checksum", "415-555-0136"), ("s3Key", "media/../../x.jpg"), ("s3Key", "415-555-0136"),
                           ("mime", "call 415-555-0136"), ("generatedAt", "born 14 February 1840"), ("generatedAt", "415-555-0136")):
            self.assertIn(shape, self.check({"x": [{key: value}]}), (key, value))

    def test_hash_like_values_under_other_keys_are_identifiers_and_numbers_are_not(self):
        self.assertEqual(self.check({"note": "00b5eb85e13415ab52be7b30557c"}), [], "a hash with a hex letter is an identifier")
        self.assertIn("privacy.detector.phone", self.check({"note": "4155550136"}))

    def test_not_json_is_a_violation(self):
        self.assertEqual(self.c.check(b"\xff\xfe"), [errors.RULE_NOT_JSON])
        self.assertEqual(self.c.check(b"{"), [errors.RULE_NOT_JSON])


class PlantedValues(unittest.TestCase):
    def test_a_planted_birth_date_blocks_the_files_that_carry_it(self):
        rig = sup.Rig("live")
        rig.run()
        before = rig.site_files()
        event = handle_of("E0001")
        obj = head_obj(rig, "Event", event)
        plant_date(obj)
        rig.store.put(obj)
        with self.assertLogs("hfy.render", level="DEBUG") as logs:
            out = rig.run()
        after = rig.site_files()
        carriers = [f"event/{event}.json", "person/I0001.json"]
        self.assertGreaterEqual(out["blocked"], 2)
        self.assertEqual(rig.metrics.count("RenderPrivacyBlock"), out["blocked"])
        for key in carriers:
            self.assertEqual(after[key], before[key], f"{key} keeps the last good copy")
        report = json.loads(rig.sync_store["render/reports/%d.json" % rig.table.head_seq()])
        blocked = {b["key"]: b["rules"] for b in report["blocked"]}
        for key in carriers:
            self.assertIn(errors.RULE_DATE_TEXT, blocked[key])
        self.assertTrue(rig.state()["last_error"].startswith("RenderPrivacyBlock:privacy."))
        self.assertEqual(rig.state()["blocked_files"], out["blocked"])
        for text in ([v.decode() for v in after.values()] + [json.dumps(rig.state(), default=str)] + logs.output
                     + [v.decode() for v in rig.sync_store.values()]):
            self.assertNotIn(PLANTED_DATE_TEXT, text)
            self.assertNotIn(PLANTED_YEAR_FRAGMENT, text)

    def test_a_planted_contact_blocks_the_person_and_the_indexes(self):
        rig = sup.Rig("live")
        rig.run()
        before = rig.site_files()
        person = handle_of("I0004")
        obj = head_obj(rig, "Person", person)
        plant_phone(obj)
        rig.store.put(obj)
        with self.assertLogs("hfy.render", level="DEBUG") as logs:
            out = rig.run()
        after = rig.site_files()
        blocked = {b["key"] for b in json.loads(rig.sync_store["render/reports/%d.json" % rig.table.head_seq()])["blocked"]}
        self.assertIn("person/I0004.json", blocked)
        self.assertIn("person/index.json", blocked)
        self.assertIn("person/search-index.json", blocked)
        self.assertEqual(after["person/I0004.json"], before["person/I0004.json"])
        self.assertEqual(rig.metrics.count("RenderPrivacyBlock"), out["blocked"])
        for text in ([v.decode() for v in after.values()] + [json.dumps(rig.state(), default=str)] + logs.output
                     + [v.decode() for v in rig.sync_store.values()]):
            self.assertNotIn(PLANTED_PHONE, text)
        self.assertNotIn("PLANTED", json.dumps(rig.table.outbox()))

    def test_a_planted_value_in_a_new_object_is_never_written(self):
        rig = sup.Rig("live")
        obj = head_obj(rig, "Person", handle_of("I0004"))
        plant_phone(obj)
        rig.store.put(obj)
        out = rig.run()
        self.assertGreaterEqual(out["blocked"], 3)
        self.assertNotIn("person/I0004.json", rig.site_files())
        self.assertNotIn("person/I0004.json", rig.manifest("live"))
        self.assertEqual(rig.site.deletes, [])

    def test_a_blocked_file_is_not_deleted_when_it_already_exists(self):
        rig = sup.Rig("live")
        rig.run()
        obj = head_obj(rig, "Person", handle_of("I0004"))
        plant_phone(obj)
        rig.store.put(obj)
        rig.run()
        self.assertEqual(rig.site.deletes, [])
        self.assertIn("person/I0004.json", rig.manifest("live"))

    def test_the_fix_unblocks_the_file(self):
        rig = sup.Rig("live")
        rig.run()
        obj = head_obj(rig, "Person", handle_of("I0004"))
        original = obj["primary_name"]["first_name"]
        plant_phone(obj)
        rig.store.put(obj)
        rig.run()
        obj["primary_name"]["first_name"] = original
        rig.store.put(obj)
        out = rig.run()
        self.assertEqual(out["blocked"], 0)
        self.assertNotIn("last_error", rig.state())

    def test_a_key_the_renderer_does_not_own_is_blocked_before_any_write(self):
        rig = sup.Rig("live")
        obj = head_obj(rig, "Person", handle_of("I0004"))
        obj["gramps_id"] = "../../x"
        rig.store.put(obj)
        out = rig.run()
        self.assertGreaterEqual(out["blocked"], 1)
        self.assertFalse([k for k in rig.site.puts if not k.endswith(".json") or ".." in k])


class WithdrawWithBlockedAggregate(unittest.TestCase):
    """A withdraw whose pass also has a blocked file must not report success: the blocked aggregate may still name the person."""

    def test_the_withdraw_is_held_alarmed_and_retried_until_the_block_clears(self):
        rig = sup.Rig("live")
        rig.run()
        seq_before = rig.state()["rendered_seq"]
        before = rig.site_files()
        other = head_obj(rig, "Person", handle_of("I0005"))
        original = other["primary_name"]["first_name"]
        plant_phone(other)
        rig.store.put(other)
        rig.store.remove("Person", handle_of("I0004"), op="withdraw", reason="private", origin="admin")
        with self.assertLogs("hfy.render", level="DEBUG") as logs:
            out = rig.run()
        self.assertEqual((out["status"], out["reason"]), ("blocked", errors.RULE_WITHDRAW_BLOCKED))
        self.assertEqual(rig.state()["rendered_seq"], seq_before, "the cursor does not move")
        self.assertEqual(rig.state()["last_error"], "RenderFailed:guard.withdraw_blocked")
        self.assertEqual(rig.metrics.count("RenderPrivacyBlock"), out["blocked"], "the privacy-block alarm fires")
        self.assertGreaterEqual(out["blocked"], 3)
        self.assertNotIn("person/I0004.json", rig.site_files(), "the withdrawn person's own file is still removed")
        self.assertEqual(rig.site_files()["person/index.json"], before["person/index.json"], "the blocked index keeps its last good copy")
        for text in logs.output + [json.dumps(rig.state(), default=str)] + [v.decode() for v in rig.sync_store.values()]:
            self.assertNotIn(PLANTED_PHONE, text)
        self.assertEqual(len(rig.table.outbox()), 1, "no outbox item for the held range")
        again = rig.run()
        self.assertEqual(again["status"], "blocked")
        self.assertEqual(rig.metrics.count("RenderPrivacyBlock"), 2 * out["blocked"], "the schedule alarms again")
        other["primary_name"]["first_name"] = original
        rig.store.put(other)
        done = rig.run()
        self.assertEqual((done["status"], done["blocked"]), ("rendered", 0))
        self.assertEqual(rig.state()["rendered_seq"], rig.table.head_seq())
        self.assertNotIn("last_error", rig.state())
        self.assertNotIn("I0004", rig.site_files()["person/index.json"].decode())

    def test_a_block_without_a_withdraw_still_advances(self):
        rig = sup.Rig("live")
        rig.run()
        obj = head_obj(rig, "Person", handle_of("I0004"))
        plant_phone(obj)
        rig.store.put(obj)
        out = rig.run()
        self.assertEqual(out["status"], "rendered")
        self.assertNotEqual(rig.state()["last_error"], "RenderFailed:guard.withdraw_blocked")
        self.assertEqual(rig.state()["rendered_seq"], rig.table.head_seq())

    def test_shadow_mode_is_not_held(self):
        rig = sup.Rig("shadow")
        rig.run()
        other = head_obj(rig, "Person", handle_of("I0005"))
        plant_phone(other)
        rig.store.put(other)
        rig.store.remove("Person", handle_of("I0004"), op="withdraw", reason="private", origin="admin")
        self.assertEqual(rig.run()["status"], "rendered")


class PlantedIdentifier(unittest.TestCase):
    def test_a_phone_like_gramps_id_blocks_the_files_that_carry_it(self):
        rig = sup.Rig("live")
        rig.run()
        before = rig.site_files()
        obj = head_obj(rig, "Person", handle_of("I0004"))
        obj["gramps_id"] = "4155550136"
        rig.store.put(obj)
        out = rig.run()
        self.assertGreaterEqual(out["blocked"], 1)
        report = json.loads(rig.sync_store["render/reports/%d.json" % rig.table.head_seq()])
        rules = {r for b in report["blocked"] for r in b["rules"]}
        self.assertIn(errors.RULE_IDENTIFIER_SHAPE, rules)
        self.assertNotIn("person/4155550136.json", rig.site_files())
        self.assertEqual(rig.site_files()["person/index.json"], before["person/index.json"])
        self.assertNotIn("4155550136", "".join(v.decode() for v in rig.site_files().values()))


class NoMessagesAnywhere(unittest.TestCase):
    PLANTED = "MARKER-7Q born 1840-02-14, call " + PLANTED_PHONE

    def failing_gate(self, text):
        raise ValueError(self.PLANTED)

    def test_last_error_holds_the_class_and_never_the_message(self):
        rig = sup.Rig("live", text_gate=self.failing_gate)
        with self.assertLogs("hfy.render", level="DEBUG") as logs:
            with self.assertRaises(errors.RenderFailed) as ctx:
                rig.run()
        state = rig.state()
        self.assertEqual(state["last_error"], "ValueError")
        self.assertNotIn("rendered_seq", state)
        self.assertEqual(str(ctx.exception), "pass.failed")
        self.assertEqual(ctx.exception.cause_class, "ValueError")
        self.assertIsNone(ctx.exception.__cause__)
        self.assertTrue(ctx.exception.__suppress_context__)
        self.assertEqual(rig.metrics.count("RenderError"), 1)
        for needle in (self.PLANTED, PLANTED_PHONE, "MARKER-7Q"):
            self.assertNotIn(needle, everything_stored(rig))
            self.assertNotIn(needle, "\n".join(logs.output))
            self.assertNotIn(needle, repr(ctx.exception))

    def test_a_rule_failure_stores_class_and_rule_id(self):
        rig = sup.Rig("live")
        rig.site.lie_checksum = True
        with self.assertRaises(errors.RenderFailed):
            rig.run()
        self.assertEqual(rig.state()["last_error"], "RenderFailed:write.checksum_mismatch")

    def test_a_storage_failure_stores_its_class_only(self):
        rig = sup.Rig("live")
        rig.site.fail_put_after = 0
        with self.assertRaises(errors.RenderFailed) as ctx:
            rig.run()
        self.assertEqual(rig.state()["last_error"], "OSError")
        self.assertNotIn("MARKER-7Q", everything_stored(rig) + repr(ctx.exception))

    def test_success_clears_last_error(self):
        rig = sup.Rig("live", text_gate=self.failing_gate)
        with self.assertRaises(errors.RenderFailed):
            rig.run()
        rig.text_gate = None
        rig.run()
        self.assertNotIn("last_error", rig.state())

    def test_describe_never_returns_a_message(self):
        class Odd(Exception):
            pass

        self.assertEqual(errors.describe(Odd("secret 415-555-0136")), ("Odd", None))
        self.assertEqual(errors.last_error_text(errors.RenderFailed("a.rule", "Boom")), "Boom:a.rule")
        self.assertEqual(errors.describe(Odd("x"))[0], "Odd")
        weird = type("Bad Name!", (Exception,), {})
        self.assertRegex(errors.describe(weird("m"))[0], r"^[A-Za-z0-9_.:-]+$")


if __name__ == "__main__":
    logging.disable(logging.NOTSET)
    unittest.main()
