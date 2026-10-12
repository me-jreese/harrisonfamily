"""Static checks on infrastructure/cloudformation/edge-gate-stack.yaml (HFY-TSK-080). Offline; run via scripts/infra/test/run.sh."""
import pathlib
import re
import unittest

import yaml

from test_app_stack import CfnLoader

ROOT = pathlib.Path(__file__).resolve().parents[3]


class EdgeGateStack(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.t = yaml.load((ROOT / "infrastructure" / "cloudformation" / "edge-gate-stack.yaml").read_text(), Loader=CfnLoader)

    def test_role_trusts_lambda_and_edgelambda(self):
        svc = self.t["Resources"]["Role"]["Properties"]["AssumeRolePolicyDocument"]["Statement"][0]["Principal"]["Service"]
        self.assertEqual(sorted(svc), ["edgelambda.amazonaws.com", "lambda.amazonaws.com"])

    def test_function_is_edge_compatible(self):
        p = self.t["Resources"]["Function"]["Properties"]
        self.assertNotIn("Environment", p)  # Lambda@Edge has no environment variables
        self.assertNotIn("VpcConfig", p)
        self.assertNotIn("Layers", p)
        self.assertNotIn("DeadLetterConfig", p)
        self.assertEqual(p["Runtime"], "nodejs22.x")
        self.assertEqual(p["Handler"], "index.handler")
        self.assertLessEqual(p["Timeout"], 5)  # viewer-request limit
        self.assertLessEqual(p["MemorySize"], 128)

    def test_version_is_retained_and_output(self):
        v = self.t["Resources"]["Version"]
        self.assertEqual(v["DeletionPolicy"], "Retain")  # CloudFront replicas pin versions
        self.assertEqual(self.t["Outputs"]["EdgeGateVersionArn"]["Value"], {"Ref": "Version"})

    # cfn-code-never-updates / edge-gate-update-same-key-fails: every build is a new S3 key, so Function.Code changes with the code
    def test_code_location_is_content_addressed(self):
        code = self.t["Resources"]["Function"]["Properties"]["Code"]
        self.assertEqual(code, {"S3Bucket": {"Ref": "CodeBucket"}, "S3Key": {"Ref": "CodeKey"}})
        key = self.t["Parameters"]["CodeKey"]
        self.assertNotIn("Default", key, "a fixed default key cannot ship a fix (re-uploading to it leaves Function.Code unchanged)")
        pat = re.compile(key["AllowedPattern"])
        self.assertTrue(pat.match("lambda/hfy-edge-gate-c95a950493cf12bd.zip"))
        for bad in ("lambda/hfy-edge-gate.zip", "lambda/hfy-edge-gate-latest.zip", "lambda/hfy-edge-gate-C95A950493CF12BD.zip", "x/lambda/hfy-edge-gate-c95a950493cf12bd.zip"):
            self.assertIsNone(pat.match(bad), bad)

    def test_version_republishes_on_every_code_change(self):
        v = self.t["Resources"]["Version"]["Properties"]
        self.assertEqual(v["FunctionName"], {"Ref": "Function"})
        self.assertEqual(v["CodeSha256"], {"Ref": "CodeSha256"})  # PublishVersion checks $LATEST against it
        desc = v["Description"]["Fn::Sub"]
        self.assertIn("${CodeSha256}", desc)
        self.assertIn("${CodeKey}", desc)
        sha = re.compile(self.t["Parameters"]["CodeSha256"]["AllowedPattern"])
        self.assertTrue(sha.match("yVqVBJPPEr2B7YfniOoUVe9MWf8dx3df2Jg6wEKlotw="))
        self.assertIsNone(sha.match("c95a950493cf12bd"))
        self.assertNotIn("Default", self.t["Parameters"]["CodeSha256"])

    def test_us_east_1_only(self):
        a = self.t["Rules"]["UsEast1Only"]["Assertions"][0]["Assert"]
        self.assertEqual(a, {"Fn::Equals": [{"Ref": "AWS::Region"}, "us-east-1"]})


if __name__ == "__main__":
    unittest.main()
