"""hfy-sync-render (HFY-TSK-276, log-hygiene-suite, review PS-20): the renderer half of the captured-log test.

The fixture date of birth, phone number and note text come from api/test/vectors/log-hygiene-fixtures.json, the file the api suite
(api/test/log-hygiene.test.js, which runs this module) and the chat Worker suite read too. They are planted into every failure the
renderer can meet: an exception whose message quotes them, a store whose objects carry them, a failing bucket, table, metrics sink and
graph trigger. After each, no log line, no ``SYNC#RENDER`` field (``last_error`` included), no metric, no report or manifest, and no
exception that leaves the pass or the handler may hold a needle. Run: python3 -m unittest discover -s gramps/tests/unit -p test_render_log_hygiene.py
"""

import json
import logging
import os
import traceback
import unittest

import render_lambda_support as sup
import render_support as rs
from hfy_render import aws, errors

FX = json.load(open(os.path.join(sup.REPO, "api", "test", "vectors", "log-hygiene-fixtures.json"), encoding="utf-8"))
DOB, PHONE, NOTE, NEEDLES = FX["dob"], FX["phone"], FX["note"], FX["needles"]
PLANTED = "%s | born %s | call %s" % (NOTE, DOB, PHONE)


def squeeze(text):
    return "".join(ch for ch in text.lower() if ch.isalnum())


def needles_in(text):
    """The needles found in ``text``, as is and with punctuation and spacing squeezed out (a digits-only phone number)."""
    lower, flat = text.lower(), squeeze(text)
    return [n for n in NEEDLES if n.lower() in lower or (len(squeeze(n)) >= 8 and squeeze(n) in flat)]


def handle_of(gramps_id):
    return [o for o in rs.p_fixture() if o.get("gramps_id") == gramps_id][0]["handle"]


def head_obj(rig, cls, handle):
    return json.loads(rig.table.items[(f"REC#{cls}#{handle}", "HEAD")]["obj_json"])


class Detector(unittest.TestCase):
    def test_finds_each_needle_in_the_shapes_a_log_line_gives_it(self):
        self.assertTrue(needles_in("born 1911-03-27"))
        self.assertTrue(needles_in("call (415) 555-0199"))
        self.assertTrue(needles_in("call 415 555 0199"))
        self.assertTrue(needles_in("ZQ7XMARKER"))
        self.assertEqual(needles_in("render failed class=ValueError rule=privacy.date_text files=3"), [])


class Surfaces(unittest.TestCase):
    """What an operator or an outside reader sees of a renderer pass, gathered in one place."""

    def assertClean(self, rig, logs, *exceptions, label=""):
        seen = {"log": "\n".join(logs.output) if logs else "", "state": json.dumps(rig.state(), default=str, sort_keys=True), "metrics": repr(rig.metrics.events)}
        # the report, the manifest and every other object the renderer wrote beside the site (the table's store items hold the planted data on purpose)
        seen["sync bucket"] = "\n".join(v.decode("utf-8", "replace") for k, v in rig.sync_store.items() if k.startswith("render"))
        seen["outbox"] = json.dumps(rig.table.outbox(), default=str, sort_keys=True)
        for i, exc in enumerate(exceptions):
            seen["exception %d" % i] = "\n".join([str(exc), repr(exc), repr(exc.args), "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))])
        for where, text in seen.items():
            self.assertEqual(needles_in(text), [], "%s: %s holds a planted value: %s" % (label, where, text[:300]))


class Failures(Surfaces):
    def run_failing(self, rig):
        with self.assertLogs("hfy.render", level="DEBUG") as logs:
            with self.assertRaises(errors.RenderFailed) as ctx:
                rig.run()
        return logs, ctx.exception

    def test_an_exception_whose_message_quotes_the_values(self):
        for exc_type in (ValueError, KeyError, OSError, json.JSONDecodeError):
            def gate(text, exc_type=exc_type):
                if exc_type is json.JSONDecodeError:
                    raise json.JSONDecodeError(PLANTED, PLANTED, 0)
                raise exc_type(PLANTED)

            rig = sup.Rig("live", text_gate=gate)
            logs, exc = self.run_failing(rig)
            self.assertEqual(rig.state()["last_error"], exc_type.__name__)
            self.assertClean(rig, logs, exc, label=exc_type.__name__)

    def test_a_cause_chain_that_quotes_the_values_does_not_leave_the_pass(self):
        def gate(text):
            try:
                raise ValueError(PLANTED)
            except ValueError as inner:
                raise RuntimeError("wrapped: %s" % PLANTED) from inner

        rig = sup.Rig("live", text_gate=gate)
        logs, exc = self.run_failing(rig)
        self.assertIsNone(exc.__cause__)
        self.assertTrue(exc.__suppress_context__)
        self.assertClean(rig, logs, exc, label="chain")

    def test_a_failing_bucket_table_and_commit(self):
        def put_fails(key, body, sha):
            raise OSError("S3 refused %s: %s" % (key, PLANTED))

        rig = sup.Rig("live")
        rig.site.put = put_fails
        logs, exc = self.run_failing(rig)
        self.assertClean(rig, logs, exc, label="put")

        def commit_fails(expect, fields, remove, outbox):
            raise RuntimeError("ConditionalCheckFailed Item=%s" % PLANTED)

        rig = sup.Rig("live")
        rig.table.commit_pass = commit_fails
        logs, exc = self.run_failing(rig)
        self.assertClean(rig, logs, exc, label="commit")

        rig = sup.Rig("live")
        rig.table.query_log = lambda lo, hi: (_ for _ in ()).throw(RuntimeError(PLANTED))
        logs, exc = self.run_failing(rig)
        self.assertClean(rig, logs, exc, label="query_log")

    def test_a_failing_graph_trigger_and_a_failing_metrics_sink(self):
        class Trigger:
            def invoke(self, *a, **k):
                raise RuntimeError(PLANTED)

            __call__ = invoke

        rig = sup.Rig("live", graph_trigger=Trigger())
        with self.assertLogs("hfy.render", level="DEBUG") as logs:
            try:
                rig.run()
            except errors.RenderFailed as exc:
                self.assertClean(rig, logs, exc, label="graph")
            else:
                self.assertClean(rig, logs, label="graph")

        class Client:
            def put_metric_data(self, **kwargs):
                raise RuntimeError(PLANTED)

        sink = aws.CloudWatchMetrics(Client(), "HFY/Test", logging.getLogger("hfy.render"))
        with self.assertLogs("hfy.render", level="DEBUG") as logs:
            sink.emit("RenderError", 1)
        self.assertEqual(needles_in("\n".join(logs.output)), [])


class PlantedInTheStore(Surfaces):
    """The values are in the data the renderer reads, not in an exception: the privacy block names rule ids, never the text."""

    def plant(self, rig, fn):
        obj = head_obj(rig, "Note", handle_of("N0001"))
        fn(obj)
        rig.store.put(obj)

    def test_a_note_carrying_a_phone_number_a_birth_date_and_the_note_text(self):
        rig = sup.Rig("live")
        rig.run()
        def set_text(obj):
            obj["text"]["string"] = PLANTED
            obj["text"]["tags"] = []
        self.plant(rig, set_text)
        with self.assertLogs("hfy.render", level="DEBUG") as logs:
            rig.run()
        # a note the redaction drops from the output is not a failure: it leaves the site, and nothing about it is logged or stored
        self.assertClean(rig, logs, label="planted note")
        self.assertEqual(needles_in("\n".join(v.decode("utf-8", "replace") for v in rig.site.objects.values())), [], "the blocked output was published")

    def test_a_person_whose_name_and_dates_carry_the_values(self):
        rig = sup.Rig("live")
        rig.run()
        handle = handle_of("I0001")
        obj = head_obj(rig, "Person", handle)
        obj["primary_name"]["first_name"] = PLANTED
        rig.store.put(obj)
        with self.assertLogs("hfy.render", level="DEBUG") as logs:
            rig.run()
        self.assertClean(rig, logs, label="planted name")
        self.assertEqual(needles_in("\n".join(v.decode("utf-8", "replace") for v in rig.site.objects.values())), [], "the blocked output was published")


class HandlerEntry(Surfaces):
    def test_the_stream_wake_up_and_the_schedule_invoke_leave_no_message(self):
        import handler as lambda_handler

        class Boom(errors.RenderFailed):
            pass

        class Eng:
            def run(self, event):
                raise Boom("guard.mass_delete", "ValueError")

        saved = lambda_handler.build_engine
        lambda_handler.build_engine = lambda context=None, environ=None: Eng()
        os.environ["RENDER_MODE"] = "live"
        try:
            stream = {"Records": [{"eventSource": "aws:dynamodb", "dynamodb": {"Keys": {"note": {"S": PLANTED}}, "NewImage": {"text": {"S": PLANTED}}}}]}
            with self.assertLogs("hfy.render", level="DEBUG") as logs:
                self.assertEqual(lambda_handler.handler(stream, None), {"batchItemFailures": []})
            self.assertEqual(needles_in("\n".join(logs.output)), [])
            with self.assertRaises(errors.RenderFailed) as ctx:
                lambda_handler.handler({"source": "schedule", "note": PLANTED}, None)
            text = "".join(traceback.format_exception(type(ctx.exception), ctx.exception, ctx.exception.__traceback__)) + repr(ctx.exception)
            self.assertEqual(needles_in(text), [])
        finally:
            lambda_handler.build_engine = saved
            os.environ.pop("RENDER_MODE", None)


if __name__ == "__main__":
    unittest.main()
