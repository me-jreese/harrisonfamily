"""Static checks on infrastructure/cloudformation/edge-gate-stack.yaml (HFY-TSK-080). Offline; run via scripts/infra/test/run.sh."""
import pathlib
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

    def test_us_east_1_only(self):
        a = self.t["Rules"]["UsEast1Only"]["Assertions"][0]["Assert"]
        self.assertEqual(a, {"Fn::Equals": [{"Ref": "AWS::Region"}, "us-east-1"]})


if __name__ == "__main__":
    unittest.main()
