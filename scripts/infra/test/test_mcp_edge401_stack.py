"""Static checks on infrastructure/mcp-edge401.us-east-1.yaml (edge401-version-not-republished). Offline; run via scripts/infra/test/run.sh."""
import hashlib
import pathlib
import re
import unittest

import yaml

from test_app_stack import CfnLoader

ROOT = pathlib.Path(__file__).resolve().parents[3]
TEMPLATE = ROOT / "infrastructure" / "mcp-edge401.us-east-1.yaml"


def code_hash(zipfile_text):
    return hashlib.sha256(zipfile_text.encode("utf-8")).hexdigest()[:16]


class McpEdge401Stack(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.t = yaml.load(TEMPLATE.read_text(), Loader=CfnLoader)
        cls.code = cls.t["Resources"]["Edge401Function"]["Properties"]["Code"]["ZipFile"]
        cls.version = cls.t["Resources"]["Edge401Version"]

    def test_version_description_carries_the_inline_code_hash(self):
        # An inline-code edit must change the Version resource, or CloudFormation never publishes a new version.
        desc = self.version["Properties"]["Description"]
        m = re.search(r"code sha256 ([0-9a-f]{16})\b", desc)
        self.assertIsNotNone(m, f"Edge401Version Description must carry 'code sha256 <16 hex>', got {desc!r}")
        self.assertEqual(m.group(1), code_hash(self.code),
                         f"the inline code changed: set Edge401Version Description to 'code sha256 {code_hash(self.code)}' so a new version is published")

    def test_any_code_edit_changes_the_expected_hash(self):
        self.assertNotEqual(code_hash(self.code), code_hash(self.code.replace('"401"', '"403"')))
        self.assertNotEqual(code_hash(self.code), code_hash(self.code + "\n"))

    def test_version_is_retained_and_output(self):
        self.assertEqual(self.version["DeletionPolicy"], "Retain")
        self.assertEqual(self.version["UpdateReplacePolicy"], "Retain")
        self.assertEqual(self.version["Properties"]["FunctionName"], {"Ref": "Edge401Function"})
        self.assertEqual(self.t["Outputs"]["Edge401FunctionVersionArn"]["Value"], {"Ref": "Edge401Version"})

    def test_no_misleading_codesha256_claim(self):
        # The template used to claim "CodeSha256 forces it" while setting no CodeSha256.
        self.assertNotIn("CodeSha256 forces it", TEMPLATE.read_text())


if __name__ == "__main__":
    unittest.main()
