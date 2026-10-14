"""hfy-sync-render (HFY-TSK-176): the Lambda entry point and the boto3 adapters.

The handler tests need nothing but the standard library. The adapter tests use botocore's Stubber and are skipped when boto3 is not
installed (CI's stock python3 has none; the Lambda runtime and the maintainers' machines do).
"""

import base64
import hashlib
import importlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import render_lambda_support as sup
from hfy_render import errors

try:
    import boto3
    from botocore.stub import ANY, Stubber

    HAVE_BOTO = True
except ImportError:  # pragma: no cover
    HAVE_BOTO = False

handler = importlib.import_module("handler")


class HandlerEntry(unittest.TestCase):
    STREAM = {"Records": [{"eventSource": "aws:dynamodb", "eventName": "INSERT", "dynamodb": {"Keys": {"PK": {"S": "SYNC#LOG"}}}}]}

    def run_with(self, mode, event, engine=None):
        with mock.patch.dict(os.environ, {"RENDER_MODE": mode}):
            if engine is not None:
                with mock.patch.object(handler, "build_engine", return_value=engine):
                    return handler.handler(event, None)
            return handler.handler(event, None)

    def test_off_returns_at_once_without_boto3_or_any_call(self):
        with mock.patch.object(handler, "_clients", side_effect=AssertionError("no AWS client under RENDER_MODE=off")):
            self.assertEqual(self.run_with("off", {"source": "schedule"}), {"status": "noop", "mode": "off"})
            self.assertEqual(self.run_with("off", self.STREAM), {"batchItemFailures": []})

    def test_the_default_mode_is_off(self):
        env = {k: v for k, v in os.environ.items() if k != "RENDER_MODE"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(handler.handler({}, None)["status"], "noop")

    def test_an_unknown_mode_fails_loudly(self):
        with self.assertRaises(RuntimeError):
            self.run_with("sideways", {})

    def test_a_stream_batch_reports_no_item_failures_and_a_schedule_returns_the_summary(self):
        rig = sup.Rig("live")
        self.assertEqual(self.run_with("live", self.STREAM, rig.engine()), {"batchItemFailures": []})
        self.assertEqual(rig.state()["rendered_seq"], rig.table.head_seq())
        out = self.run_with("live", {"source": "schedule"}, rig.engine())
        self.assertEqual(out["status"], "reconciled", "the first schedule invocation also runs the daily reconcile")

    def test_a_failed_pass_raises_without_a_message(self):
        rig = sup.Rig("live", text_gate=lambda text: (_ for _ in ()).throw(ValueError("born 1840-02-14 MARKER-7Q")))
        with self.assertRaises(errors.RenderFailed) as ctx:
            self.run_with("live", self.STREAM, rig.engine())
        self.assertNotIn("MARKER-7Q", repr(ctx.exception) + str(ctx.exception))


@unittest.skipUnless(HAVE_BOTO, "boto3 is not installed")
class DynamoAdapter(unittest.TestCase):
    def setUp(self):
        from hfy_render import aws

        self.aws = aws
        self.client = boto3.client("dynamodb", region_name="us-west-2", aws_access_key_id="x", aws_secret_access_key="y")
        self.stub = Stubber(self.client)
        self.stub.activate()
        self.table = aws.DynamoTable(self.client, "hfy-app-test")

    def tearDown(self):
        self.stub.assert_no_pending_responses()

    def test_get_is_consistent_and_numbers_come_back_as_ints(self):
        self.stub.add_response("get_item", {"Item": {"PK": {"S": "SYNC#HEAD"}, "SK": {"S": "META"}, "seq": {"N": "12"}}}, {
            "TableName": "hfy-app-test", "Key": {"PK": {"S": "SYNC#HEAD"}, "SK": {"S": "META"}}, "ConsistentRead": True})
        item = self.table.get("SYNC#HEAD", "META")
        self.assertEqual(item["seq"], 12)
        self.assertIsInstance(item["seq"], int)

    def test_query_log_pages_and_is_consistent(self):
        expected = {
            "TableName": "hfy-app-test", "ConsistentRead": True, "KeyConditionExpression": "PK = :pk AND SK BETWEEN :lo AND :hi",
            "ExpressionAttributeValues": {":pk": {"S": "SYNC#LOG"}, ":lo": {"S": "000000000001"}, ":hi": {"S": "000000000009"}},
        }
        last = {"PK": {"S": "SYNC#LOG"}, "SK": {"S": "000000000002"}}
        self.stub.add_response("query", {"Items": [{"seq": {"N": "1"}}, {"seq": {"N": "2"}}], "LastEvaluatedKey": last}, expected)
        self.stub.add_response("query", {"Items": [{"seq": {"N": "3"}}]}, {**expected, "ExclusiveStartKey": last})
        self.assertEqual([i["seq"] for i in self.table.query_log(1, 9)], [1, 2, 3])

    def test_batch_get_retries_unprocessed_keys(self):
        k1, k2 = ("REC#Media#a", "HEAD"), ("REC#Media#b", "HEAD")
        enc = lambda k: {"PK": {"S": k[0]}, "SK": {"S": k[1]}}  # noqa: E731
        self.stub.add_response("batch_get_item", {"Responses": {"hfy-app-test": [{**enc(k1), "seq": {"N": "1"}}]}, "UnprocessedKeys": {"hfy-app-test": {"Keys": [enc(k2)], "ConsistentRead": True}}},
                               {"RequestItems": {"hfy-app-test": {"Keys": [enc(k1), enc(k2)], "ConsistentRead": True}}})
        self.stub.add_response("batch_get_item", {"Responses": {"hfy-app-test": [{**enc(k2), "seq": {"N": "2"}}]}},
                               {"RequestItems": {"hfy-app-test": {"Keys": [enc(k2)], "ConsistentRead": True}}})
        got = self.table.batch_get([k1, k2, k1])
        self.assertEqual({k: v["seq"] for k, v in got.items()}, {k1: 1, k2: 2})

    def test_query_heads_reads_the_gsi_of_the_class(self):
        self.stub.add_response("query", {"Items": []}, {"TableName": "hfy-app-test", "IndexName": "GSI1", "KeyConditionExpression": "GSI1PK = :pk",
                                                       "ExpressionAttributeValues": {":pk": {"S": "RECS#Person"}}})
        self.assertEqual(list(self.table.query_heads("Person")), [])

    def test_commit_pass_is_one_conditional_transaction_with_the_outbox(self):
        captured = {}

        self.client.meta.events.register("provide-client-params.dynamodb.TransactWriteItems", lambda params, **kw: captured.update(params))
        self.stub.add_response("transact_write_items", {}, {"TransactItems": ANY})
        outbox = {"PK": "SYNC#RENDERED", "SK": "000000000007", "seq_to": 7, "changed_people": ["I0001"]}
        self.table.commit_pass(6, {"rendered_seq": 7, "mode": "live"}, ["last_error"], outbox)
        items = captured["TransactItems"]
        update, put = items[0]["Update"], items[1]["Put"]
        self.assertEqual(update["ConditionExpression"], "rendered_seq = :expect")
        self.assertEqual(update["ExpressionAttributeValues"][":expect"], {"N": "6"})
        self.assertIn("REMOVE", update["UpdateExpression"])
        self.assertEqual(update["Key"], {"PK": {"S": "SYNC#RENDER"}, "SK": {"S": "STATE"}})
        self.assertEqual(put["Item"]["changed_people"], {"L": [{"S": "I0001"}]})
        self.assertNotIn("ConditionExpression", put)

    def test_a_first_commit_requires_no_cursor_and_a_cancelled_transaction_is_a_state_conflict(self):
        self.stub.add_client_error("transact_write_items", service_error_code="TransactionCanceledException")
        with self.assertRaises(errors.RenderFailed) as ctx:
            self.table.commit_pass(None, {"rendered_seq": 1}, [], None)
        self.assertEqual(ctx.exception.rule, errors.RULE_STATE_CONFLICT)

    def test_write_state_sets_and_removes(self):
        self.stub.add_response("update_item", {}, {
            "TableName": "hfy-app-test", "Key": {"PK": {"S": "SYNC#RENDER"}, "SK": {"S": "STATE"}},
            "UpdateExpression": "SET #f0 = :v0 REMOVE #r0", "ExpressionAttributeNames": {"#f0": "last_error", "#r0": "old"},
            "ExpressionAttributeValues": {":v0": {"S": "OSError"}}})
        self.table.write_state({"last_error": "OSError"}, ["old"])


@unittest.skipUnless(HAVE_BOTO, "boto3 is not installed")
class S3Adapter(unittest.TestCase):
    def setUp(self):
        from hfy_render import aws

        self.aws = aws
        self.client = boto3.client("s3", region_name="us-west-2", aws_access_key_id="x", aws_secret_access_key="y")
        self.stub = Stubber(self.client)
        self.stub.activate()

    def tearDown(self):
        self.stub.assert_no_pending_responses()

    def test_put_signs_the_sha256_and_prefixes_the_key(self):
        body = b'{"a":1}'
        sha = hashlib.sha256(body).hexdigest()
        self.stub.add_response("put_object", {}, {"Bucket": "b", "Key": "render-shadow/person/I1.json", "Body": body, "ContentType": "application/json",
                                                  "ChecksumSHA256": base64.b64encode(bytes.fromhex(sha)).decode()})
        self.aws.S3Bucket(self.client, "b", "render-shadow/").put("person/I1.json", body, sha)

    def test_head_returns_the_checksum_as_hex_or_none_when_missing(self):
        sha = hashlib.sha256(b"x").hexdigest()
        self.stub.add_response("head_object", {"ChecksumSHA256": base64.b64encode(bytes.fromhex(sha)).decode()}, {"Bucket": "b", "Key": "k", "ChecksumMode": "ENABLED"})
        self.stub.add_client_error("head_object", service_error_code="404", http_status_code=404)
        bucket = self.aws.S3Bucket(self.client, "b")
        self.assertEqual(bucket.head_sha256("k"), sha)
        self.assertIsNone(bucket.head_sha256("k"))

    def test_get_of_a_missing_key_is_none(self):
        self.stub.add_client_error("get_object", service_error_code="NoSuchKey", http_status_code=404)
        self.assertIsNone(self.aws.S3Bucket(self.client, "b").get("render/manifest-live.json"))

    def test_delete_and_list_with_a_prefix(self):
        self.stub.add_response("delete_object", {}, {"Bucket": "b", "Key": "p/x.json"})
        self.stub.add_response("list_objects_v2", {"Contents": [{"Key": "p/person/a.json"}], "IsTruncated": True, "NextContinuationToken": "t"}, {"Bucket": "b", "Prefix": "p/person/"})
        self.stub.add_response("list_objects_v2", {"Contents": [{"Key": "p/person/b.json"}], "IsTruncated": False}, {"Bucket": "b", "Prefix": "p/person/", "ContinuationToken": "t"})
        bucket = self.aws.S3Bucket(self.client, "b", "p/")
        bucket.delete("x.json")
        self.assertEqual(list(bucket.list_keys("person/")), ["person/a.json", "person/b.json"])


@unittest.skipUnless(HAVE_BOTO, "boto3 is not installed")
class MetricsAdapter(unittest.TestCase):
    def test_emit_puts_a_count_and_swallows_a_failure(self):
        from hfy_render import aws

        client = boto3.client("cloudwatch", region_name="us-west-2", aws_access_key_id="x", aws_secret_access_key="y")
        stub = Stubber(client)
        stub.activate()
        stub.add_response("put_metric_data", {}, {"Namespace": "HFY/SyncRender", "MetricData": [{"MetricName": "RenderError", "Value": 1, "Unit": "Count"}]})
        stub.add_client_error("put_metric_data", service_error_code="Throttling")
        metrics = aws.CloudWatchMetrics(client, "HFY/SyncRender")
        metrics.emit("RenderError")
        metrics.emit("RenderError")
        stub.assert_no_pending_responses()


STACK = os.path.join(sup.REPO, "infrastructure", "cloudformation", "app-stack.yaml")


def read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as fh:
        return fh.read()


def stack_block(name):
    """The text of one top-level resource of the stack template (up to the next resource at the same indent)."""

    with open(STACK, encoding="utf-8") as fh:
        text = fh.read()
    m = re.search(r"^  %s:\n(.*?)(?=^  [A-Za-z0-9]+:\n|\Z)" % re.escape(name), text, re.S | re.M)
    assert m, name
    return m.group(1)


class StackContract(unittest.TestCase):
    """The Lambda and the stack template (HFY-TSK-247) agree: environment, handler, permissions, metrics, schedule input."""

    def test_the_function_settings_the_code_depends_on(self):
        fn = stack_block("RenderFunction")
        self.assertIn("Handler: handler.handler", fn)
        self.assertIn("Runtime: python3.13", fn)
        self.assertIn("ReservedConcurrentExecutions: 1", fn)
        self.assertIn("S3Key: !Ref RenderCodeKey", fn)
        env = set(re.findall(r"^\s+([A-Z_]+): !?", fn.split("Variables:")[1], re.M))
        with open(os.path.join(sup.LAMBDA, "handler.py"), encoding="utf-8") as fh:
            code = fh.read()
        used = set(re.findall(r'env(?:iron)?(?:\.get\(|\[)"([A-Z_]+)"', code))
        self.assertEqual(used, {"RENDER_MODE", "SYNC_BUCKET", "SITE_BUCKET", "TABLE_NAME", "METRICS_NAMESPACE"})
        self.assertTrue(used <= env, used - env)

    def test_the_role_can_do_what_the_engine_does_and_no_more(self):
        role = stack_block("RenderRole")
        for prefix in ("person", "family", "event", "note", "place", "media"):
            self.assertIn("${MediaBucket}/%s/*.json" % prefix, role)
        self.assertIn('"dynamodb:LeadingKeys": ["SYNC#RENDER", "SYNC#RENDERED"]', role)
        for action in ("dynamodb:Query", "dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:UpdateItem", "dynamodb:PutItem", "s3:GetObject",
                       "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "cloudwatch:PutMetricData"):
            self.assertIn(action, role)
        self.assertNotIn("dynamodb:Scan", role)
        aws_src = read(sup.LAMBDA, "hfy_render", "aws.py")
        self.assertNotIn("scan(", aws_src)
        self.assertNotIn("delete_item(", aws_src)
        self.assertEqual(set(re.findall(r'"PK": "(SYNC#[A-Z]+)"', aws_src + read(sup.LAMBDA, "hfy_render", "engine.py"))), {"SYNC#RENDERED"})
        self.assertEqual(set(re.findall(r'STATE_KEY = \("(SYNC#[A-Z]+)"', aws_src)), {"SYNC#RENDER"})

    def test_every_metric_the_engine_emits_has_an_alarm_and_the_namespace_matches(self):
        engine_src = read(sup.LAMBDA, "hfy_render", "engine.py")
        emitted = set(re.findall(r'metrics\.emit\("([A-Za-z]+)"', engine_src))
        self.assertEqual(emitted, {"RenderError", "RenderPrivacyBlock", "MassDeleteGuard", "HeadMismatch"})
        with open(STACK, encoding="utf-8") as fh:
            text = fh.read()
        alarmed = set(re.findall(r"Namespace: HFY/SyncRender\n\s+MetricName: ([A-Za-z]+)", text))
        self.assertEqual(emitted, alarmed)
        self.assertIn("METRICS_NAMESPACE: HFY/SyncRender", stack_block("RenderFunction"))
        self.assertIn('"cloudwatch:namespace": HFY/SyncRender', stack_block("RenderRole"))

    def test_the_schedule_input_is_what_the_engine_reads_as_a_schedule(self):
        from hfy_render import engine

        sched = stack_block("RenderSchedule")
        self.assertIn("""Input: '{"source":"schedule"}'""", sched)
        self.assertEqual(engine.parse_event({"source": "schedule"}).source, "schedule")
        self.assertIn("rate(15 minutes)", sched)

    def test_the_stream_filter_is_the_change_log_and_failures_are_reported_per_item(self):
        mapping = stack_block("RenderStreamMapping")
        self.assertIn("SYNC#LOG", mapping)
        self.assertIn("ReportBatchItemFailures", mapping)
        self.assertIn("BisectBatchOnFunctionError: true", mapping)


@unittest.skipUnless(shutil.which("zip"), "zip is not installed")
class PackagedZip(unittest.TestCase):
    """The built artifact, not the source tree, reproduces the golden site on the fixture store."""

    def test_the_zip_alone_renders_the_golden_site(self):
        with tempfile.TemporaryDirectory() as scratch:
            work = os.path.join(scratch, "repo")
            os.makedirs(os.path.join(work, "scripts", "ci"))
            os.makedirs(os.path.join(work, "lambda"))
            os.makedirs(os.path.join(work, "gramps"))
            shutil.copy(os.path.join(sup.REPO, "scripts", "ci", "package-render.sh"), os.path.join(work, "scripts", "ci"))
            ignore = shutil.ignore_patterns("__pycache__", "*.pyc")
            shutil.copytree(sup.LAMBDA, os.path.join(work, "lambda", "hfy-sync-render"), ignore=ignore)
            shutil.copytree(os.path.join(sup.REPO, "gramps", "hfygramps"), os.path.join(work, "gramps", "hfygramps"), ignore=ignore)
            built = subprocess.run(["bash", os.path.join(work, "scripts", "ci", "package-render.sh")], capture_output=True, text=True, timeout=120)
            self.assertEqual(built.returncode, 0, built.stderr[-400:])
            zpath = os.path.join(work, "dist", "hfy-sync-render.zip")
            script = (
                "import sys\n"
                "zip_path, tests = sys.argv[1], sys.argv[2]\n"
                "sys.path.insert(0, zip_path)\n"
                "import hfy_render.engine, hfygramps.render\n"  # bound to the zip before the repo's copies can be imported
                "assert hfy_render.engine.__file__.startswith(zip_path), hfy_render.engine.__file__\n"
                "assert hfygramps.render.__file__.startswith(zip_path), hfygramps.render.__file__\n"
                "sys.path.append(tests)\n"
                "import render_lambda_support as sup, render_support as rs\n"
                "assert hfy_render.engine.__file__.startswith(zip_path)\n"
                "rig = sup.Rig('live')\n"
                "out = rig.run()\n"
                "assert out['status'] == 'rendered', out\n"
                "assert rig.site_files() == rs.rendered()\n"
                "print('golden', len(rig.site_files()))\n"
            )
            res = subprocess.run([sys.executable, "-c", script, zpath, HERE], capture_output=True, text=True, timeout=120, cwd=scratch)
            self.assertEqual(res.returncode, 0, res.stderr[-800:])
            self.assertRegex(res.stdout, r"golden \d{3}")


HERE = os.path.dirname(os.path.abspath(__file__))


if __name__ == "__main__":
    unittest.main()
