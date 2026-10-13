"""Static checks on infrastructure/cloudformation/*.yaml for the HFY-R58 infra rulings. Offline; run via scripts/infra/test/run.sh
or: python3 -m unittest scripts/infra/test/test_app_stack.py"""
import pathlib
import re
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[3]
CFN = ROOT / "infrastructure" / "cloudformation"


class CfnLoader(yaml.SafeLoader):
    """Reads CloudFormation short-form intrinsics (!Ref, !Sub, !If, ...) as {"Ref": ...} / {"Fn::X": ...}."""


def _intrinsic(loader, suffix, node):
    name = "Ref" if suffix == "Ref" else ("Condition" if suffix == "Condition" else f"Fn::{suffix}")
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
        if suffix == "GetAtt":
            value = value.split(".", 1)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node, deep=True)
    else:
        value = loader.construct_mapping(node, deep=True)
    return {name: value}


CfnLoader.add_multi_constructor("!", _intrinsic)


def load(name):
    return yaml.load((CFN / name).read_text(), Loader=CfnLoader)


def statements(role):
    return [s for p in role["Properties"]["Policies"] for s in p["PolicyDocument"]["Statement"]]


def by_sid(role, sid):
    found = [s for s in statements(role) if isinstance(s, dict) and s.get("Sid") == sid]
    assert len(found) == 1, f"expected one statement {sid}, got {found}"
    return found[0]


class AppStack(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.t = load("app-stack.yaml")
        cls.r = cls.t["Resources"]

    # cognito-self-signup-enabled
    def test_user_pool_is_admin_create_only(self):
        pool = self.r["UserPool"]["Properties"]
        self.assertIs(pool["AdminCreateUserConfig"]["AllowAdminCreateUserOnly"], True)
        self.assertEqual(pool["UserAttributeUpdateSettings"]["AttributesRequireVerificationBeforeUpdate"], ["email"])
        self.assertIn("email", pool["AutoVerifiedAttributes"])  # required by AttributesRequireVerificationBeforeUpdate

    def test_client_still_has_no_secret_and_no_extra_flows(self):
        client = self.r["UserPoolClient"]["Properties"]
        self.assertEqual(sorted(client["ExplicitAuthFlows"]), ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_PASSWORD_AUTH"])

    def test_auth_edge_may_call_exactly_the_admin_apis_it_uses(self):
        actions = by_sid(self.r["AuthRole"], "CognitoAdminLink")["Action"]
        self.assertEqual(sorted(actions), sorted([
            "cognito-idp:AdminGetUser", "cognito-idp:AdminCreateUser", "cognito-idp:AdminSetUserPassword",
            "cognito-idp:AdminConfirmSignUp", "cognito-idp:AdminUpdateUserAttributes"]))
        self.assertNotIn("cognito-idp:SignUp", actions)
        self.assertEqual(by_sid(self.r["AuthRole"], "CognitoAdminLink")["Resource"], {"Fn::GetAtt": ["UserPool", "Arn"]})

    def test_iam_covers_every_cognito_admin_call_in_the_auth_edge(self):
        # Drift guard: every Admin* API the edge source calls (send("AdminX", ...) or AdminXCommand) must be granted.
        actions = set(by_sid(self.r["AuthRole"], "CognitoAdminLink")["Action"])
        src = "\n".join(f.read_text() for f in (ROOT / "auth" / "src").glob("*.js"))
        used = set(re.findall(r'send\(\s*"(Admin[A-Za-z]+)"', src)) | set(re.findall(r"\b(Admin[A-Za-z]+)Command\b", src))
        self.assertTrue(used, "expected the auth edge to call Cognito admin APIs")
        self.assertEqual({f"cognito-idp:{u}" for u in used} - actions, set())

    # cognito-default-email-quota: SES is opt-in (needs a verified identity); the default stays deployable.
    def test_email_configuration_switches_to_ses_when_configured(self):
        params, conds = self.t["Parameters"], self.t["Conditions"]
        self.assertEqual(params["SesIdentityArn"]["Default"], "")
        self.assertIn("HasSes", conds)
        cfg = self.r["UserPool"]["Properties"]["EmailConfiguration"]["Fn::If"]
        self.assertEqual(cfg[0], "HasSes")
        self.assertEqual(cfg[1]["EmailSendingAccount"], "DEVELOPER")
        self.assertEqual(cfg[1]["SourceArn"], {"Ref": "SesIdentityArn"})
        self.assertEqual(cfg[2], {"EmailSendingAccount": "COGNITO_DEFAULT"})

    def test_forgot_password_rate_limit_can_use_the_table(self):
        # auth/src/ratelimit.js: one UpdateItem (ADD) per hit on RATE#... items that expire through the table TTL `ttl`.
        table = self.r["Table"]["Properties"]
        self.assertEqual(table["TimeToLiveSpecification"], {"AttributeName": "ttl", "Enabled": True})
        self.assertIn("dynamodb:UpdateItem", by_sid(self.r["AuthRole"], "RefreshAndLinkStore")["Action"])

    # HFY-R58 (2): uploads/posts/, never media/ (ETL --delete), served with nosniff + sandbox CSP.
    def test_api_may_only_write_uploads_posts(self):
        st = by_sid(self.r["Role"], "PostPhotoUploads")
        self.assertEqual(st["Action"], "s3:PutObject")
        self.assertEqual(st["Resource"], {"Fn::Sub": "arn:${AWS::Partition}:s3:::${MediaBucket}/uploads/posts/*"})
        for s in statements(self.r["Role"]):
            self.assertNotIn("media/", str(s.get("Resource", "")) if isinstance(s, dict) else "")

    # HFY-TSK-236 (app-iam-w1): transact() condition checks, comment photo uploads, and upload reads (HEAD and copy source).
    def test_api_may_condition_check_items_in_the_table(self):
        self.assertIn("dynamodb:ConditionCheckItem", by_sid(self.r["Role"], "Table")["Action"])

    def test_api_may_put_comment_photos_under_uploads_comments_only(self):
        st = by_sid(self.r["Role"], "CommentPhotoUploads")
        self.assertEqual(st["Effect"], "Allow")
        self.assertEqual(st["Action"], "s3:PutObject")
        self.assertEqual(st["Resource"], {"Fn::Sub": "arn:${AWS::Partition}:s3:::${MediaBucket}/uploads/comments/*"})

    def test_api_may_read_only_the_upload_prefixes(self):
        st = by_sid(self.r["Role"], "UploadReads")
        self.assertEqual(st["Effect"], "Allow")
        self.assertEqual(st["Action"], "s3:GetObject")
        self.assertEqual(sorted(x["Fn::Sub"] for x in st["Resource"]), [
            "arn:${AWS::Partition}:s3:::${MediaBucket}/uploads/comments/*",
            "arn:${AWS::Partition}:s3:::${MediaBucket}/uploads/posts/*"])

    def test_api_role_has_no_grant_on_media_or_config_beyond_the_existing_ones(self):
        for s in statements(self.r["Role"]):
            if not isinstance(s, dict) or s.get("Sid") in ("AdminList",):
                continue
            self.assertNotIn("media/", str(s.get("Resource", "")))
            self.assertNotIn("config/", str(s.get("Resource", "")))

    # HFY-R68: author labels are the person's displayName from the site's own record, never the allowlist email. Read-only, person/* only.
    def test_api_may_only_read_person_records_for_author_labels(self):
        st = by_sid(self.r["Role"], "PersonRecords")
        self.assertEqual(st["Effect"], "Allow")
        self.assertEqual(st["Action"], "s3:GetObject")
        self.assertEqual(st["Resource"], {"Fn::Sub": "arn:${AWS::Partition}:s3:::${MediaBucket}/person/*"})
        self.assertEqual(self.r["Function"]["Properties"]["Environment"]["Variables"]["MEDIA_BUCKET"], {"Ref": "MediaBucket"})
        for s in statements(self.r["Role"]):  # no other statement mentions person/
            if isinstance(s, dict) and s.get("Sid") != "PersonRecords":
                self.assertNotIn("person/", str(s.get("Resource", "")))

    def test_uploads_response_headers_policy(self):
        cfg = self.r["UploadsResponseHeadersPolicy"]["Properties"]["ResponseHeadersPolicyConfig"]
        sec = cfg["SecurityHeadersConfig"]
        self.assertEqual(sec["ContentTypeOptions"], {"Override": True})
        self.assertEqual(sec["ContentSecurityPolicy"], {"ContentSecurityPolicy": "sandbox; default-src 'none'; img-src 'self'", "Override": True})
        self.assertEqual(self.t["Outputs"]["UploadsResponseHeadersPolicyId"]["Value"], {"Ref": "UploadsResponseHeadersPolicy"})

    def test_members_only_uploads_policy_keeps_this_templates_security_headers(self):
        # HFY members-only /uploads/*: add-data-gate-behaviors.sh creates hfy-uploads-private with the SAME nosniff + sandbox CSP.
        csp = self.r["UploadsResponseHeadersPolicy"]["Properties"]["ResponseHeadersPolicyConfig"]["SecurityHeadersConfig"]["ContentSecurityPolicy"]["ContentSecurityPolicy"]
        common = (ROOT / "scripts" / "infra" / "lib" / "cf-common.sh").read_text()
        self.assertIn('UPLOADS_CSP="%s"' % csp, common)
        gate = (ROOT / "scripts" / "infra" / "add-data-gate-behaviors.sh").read_text()
        self.assertIn("ContentSecurityPolicy:{ContentSecurityPolicy:$csp, Override:true}", gate)
        self.assertIn("ContentTypeOptions:{Override:true}", gate)

    def test_add_uploads_behavior_reads_the_output_this_stack_exports(self):
        script = (ROOT / "scripts" / "infra" / "add-uploads-behavior.sh").read_text()
        self.assertIn("OUTPUT_KEY=UploadsResponseHeadersPolicyId", script)
        for key in ("FunctionUrl", "AuthFunctionUrl"):
            self.assertIn(key, self.t["Outputs"])

    def test_gsi1_key_schema_unchanged(self):
        # auth/src/linkstore.js writes GSI1SK on LINK# items because GSI1 needs BOTH keys (HFY-R58 (6)); keep the schema stable.
        gsi = self.r["Table"]["Properties"]["GlobalSecondaryIndexes"][0]
        self.assertEqual(gsi["IndexName"], "GSI1")
        self.assertEqual(gsi["KeySchema"], [{"AttributeName": "GSI1PK", "KeyType": "HASH"}, {"AttributeName": "GSI1SK", "KeyType": "RANGE"}])


class GitHubRoles(unittest.TestCase):
    def test_ci_cannot_delete_or_overwrite_member_uploads(self):
        role = load("github-roles.yaml")["Resources"]["GitHubDeployRole"]
        st = by_sid(role, "ProtectMemberUploads")
        self.assertEqual(st["Effect"], "Deny")
        self.assertEqual(sorted(st["Action"]), ["s3:DeleteObject", "s3:PutObject"])
        self.assertEqual(st["Resource"], ["arn:aws:s3:::harrisonfamily-frontend/uploads/*"])


if __name__ == "__main__":
    unittest.main()
