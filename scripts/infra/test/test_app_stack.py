"""Static checks on infrastructure/cloudformation/*.yaml for the HFY-R58 infra rulings. Offline; run via scripts/infra/test/run.sh
or: python3 -m unittest scripts/infra/test/test_app_stack.py"""
import json
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
        for s in statements(self.r["Role"]):  # media/ is granted only by MediaBinaries (HFY-TSK-247)
            if isinstance(s, dict) and s.get("Sid") != "MediaBinaries":
                self.assertNotIn("media/", str(s.get("Resource", "")))

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

    def test_api_role_s3_grants_are_an_exact_allowlist(self):
        # Every S3 statement's resources, with the Sub resolved to bucket parameter + key pattern, must be one of the known prefixes.
        # Any other (a bare /*, media/*, a wildcard such as m*) fails. config/* is allowed only in AdminList (the config bucket).
        allowed = {"MediaBucket": {"uploads/posts/*", "uploads/comments/*", "person/*", "media/*"}, "ConfigBucket": {"config/*"},
                   "SyncBucketName": {"snapshots/*"}}
        seen = 0
        for s in statements(self.r["Role"]):
            acts = s.get("Action", [])
            acts = [acts] if isinstance(acts, str) else acts
            if not any(a.startswith("s3:") for a in acts):
                continue
            res = s["Resource"]
            for r in ([res] if not isinstance(res, list) else res):
                m = re.fullmatch(r"arn:\$\{AWS::Partition\}:s3:::\$\{(\w+)\}/(.+)", r["Fn::Sub"])
                self.assertIsNotNone(m, f"{s.get('Sid')}: unexpected S3 resource {r}")
                self.assertIn(m.group(2), allowed.get(m.group(1), set()), f"{s.get('Sid')}: {r}")
                seen += 1
        self.assertGreaterEqual(seen, 8)

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

    # privacy-guard-existing-paths AC9: the DOB refusal on posts and comments is a switch, default off, until io answers Q2-17 line 5.
    def test_dob_guard_switch_defaults_off(self):
        p = self.t["Parameters"]["GuardDob"]
        self.assertEqual(p["Default"], "off")
        self.assertEqual(p["AllowedValues"], ["off", "on"])
        self.assertEqual(self.r["Function"]["Properties"]["Environment"]["Variables"]["HFY_GUARD_DOB"], {"Ref": "GuardDob"})

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


DATA_PREFIXES = ["person", "family", "event", "note", "place", "media"]


def sub(value):
    return value["Fn::Sub"]


class SyncInfra(unittest.TestCase):
    """HFY-TSK-247: sync bucket, table stream, renderer, schedule, alarms, break-glass role, graph placeholder, default-off parameters."""

    @classmethod
    def setUpClass(cls):
        cls.t = load("app-stack.yaml")
        cls.r = cls.t["Resources"]
        cls.p = cls.t["Parameters"]

    # AC5: every default-off W2/W3 parameter, pinned with its default (later tasks change values only).
    def test_default_off_parameters_are_pinned(self):
        expected = {
            "SyncApiEnabled": "0", "RenderMode": "off", "RenderCodeKey": "lambda/hfy-sync-render-placeholder.zip",
            "HfyEditing": "off", "AccessRequests": "off", "FirstPassword": "off", "TurnstileSiteKey": "", "SesConfigurationSet": "",
            "SesIdentityArn": "", "ChatServicePublicKeys": "", "GraphRenderCodeKey": "lambda/hfy-graph-render-placeholder.zip",
            "SyncBucketName": "harrisonfamily-sync", "AlarmEmail": "",
            # HFY-TSK-195 (P2-R23): the access-request mail identity, configuration set and alarms are separate from Cognito's and the API's
            "JoinSesIdentityArn": "", "JoinFromAddress": "", "JoinSesConfigurationSet": "",
            "JoinBounceAlarmName": "hfy-ses-access-request-bounce-rate", "JoinComplaintAlarmName": "hfy-ses-access-request-complaint-rate",
        }
        for name, default in expected.items():
            self.assertIn(name, self.p, name)
            self.assertEqual(self.p[name]["Default"], default, name)
        self.assertEqual(self.p["SyncApiEnabled"]["AllowedValues"], ["0", "1"])
        self.assertEqual(self.p["RenderMode"]["AllowedValues"], ["off", "shadow", "live"])
        self.assertEqual(self.p["HfyEditing"]["AllowedValues"], ["off", "on"])
        self.assertEqual(self.p["AccessRequests"]["AllowedValues"], ["off", "on"])
        self.assertEqual(self.p["FirstPassword"]["AllowedValues"], ["off", "on"])
        self.assertNotIn("Default", self.p["BreakGlassPrincipalArn"])  # io's principal never lives in the repo

    def test_parameters_reach_the_functions(self):
        api = self.r["Function"]["Properties"]["Environment"]["Variables"]
        edge = self.r["AuthFunction"]["Properties"]["Environment"]["Variables"]
        for env, param in [("SYNC_API_ENABLED", "SyncApiEnabled"), ("HFY_EDITING", "HfyEditing"),
                           ("CHAT_SERVICE_PUBLIC_KEYS", "ChatServicePublicKeys"), ("SES_CONFIGURATION_SET", "SesConfigurationSet")]:
            self.assertEqual(api[env], {"Ref": param}, env)
        for env, param in [("ACCESS_REQUESTS", "AccessRequests"), ("FIRST_PASSWORD", "FirstPassword"), ("TURNSTILE_SITE_KEY", "TurnstileSiteKey"),
                           ("JOIN_FROM_ADDRESS", "JoinFromAddress"), ("JOIN_SES_CONFIGURATION_SET", "JoinSesConfigurationSet")]:
            self.assertEqual(edge[env], {"Ref": param}, env)
        # the edge never sends through the Cognito and API identity or configuration set
        self.assertNotIn("SES_FROM_ADDRESS", edge)
        self.assertNotIn("SES_CONFIGURATION_SET", edge)
        self.assertEqual(edge["JOIN_MAIL_ALARMS"], {"Fn::Sub": "${JoinBounceAlarmName},${JoinComplaintAlarmName}"})
        self.assertEqual(self.r["RenderFunction"]["Properties"]["Environment"]["Variables"]["RENDER_MODE"], {"Ref": "RenderMode"})

    # HFY-TSK-141 (surf-access-admin-api AC5): the api sends the admin routes' mail (approved, declined, awaiting_record, the second-email notice) with the
    # ses:SendEmail grant app-stack-sync-infra gave its role, and with the env it already carries. This task changes no IAM and adds no parameter.
    def test_api_mail_for_the_access_request_admin_routes_uses_the_sync_infra_grant(self):
        api = self.r["Function"]["Properties"]["Environment"]["Variables"]
        self.assertEqual(api["SES_FROM_ADDRESS"], {"Ref": "SesFromAddress"})
        self.assertEqual(api["SES_CONFIGURATION_SET"], {"Ref": "SesConfigurationSet"})
        ses = [s for s in statements(self.r["Role"]) if isinstance(s, dict) and s.get("Fn::If", [""])[0] == "HasSes"]
        self.assertEqual(len(ses), 1)
        st = ses[0]["Fn::If"][1]
        self.assertEqual((st["Sid"], st["Effect"], st["Action"]), ("SendEmail", "Allow", "ses:SendEmail"))
        self.assertEqual(st["Resource"][0], {"Ref": "SesIdentityArn"})
        self.assertEqual(st["Condition"], {"StringEquals": {"ses:FromAddress": {"Ref": "SesFromAddress"}}})
        # the code reads exactly these two names, and the access-request switch stays on the edge (the admin routes sit behind the accessRequests flag)
        index = (ROOT / "api" / "src" / "index.js").read_text()
        self.assertIn("env.SES_FROM_ADDRESS && env.SES_CONFIGURATION_SET", index)
        self.assertNotIn("ACCESS_REQUESTS", api)

    # The RG-dark change-set prep found the live alarms under other names than the old defaults: the defaults are the live names now.
    def test_join_alarm_defaults_are_the_live_alarm_names(self):
        self.assertEqual(self.p["JoinBounceAlarmName"]["Default"], "hfy-ses-access-request-bounce-rate")
        self.assertEqual(self.p["JoinComplaintAlarmName"]["Default"], "hfy-ses-access-request-complaint-rate")

    # AC1: bucket
    def test_sync_bucket(self):
        b = self.r["SyncBucket"]
        self.assertEqual(b["DeletionPolicy"], "Retain")
        pr = b["Properties"]
        self.assertEqual(pr["PublicAccessBlockConfiguration"], {"BlockPublicAcls": True, "BlockPublicPolicy": True, "IgnorePublicAcls": True, "RestrictPublicBuckets": True})
        self.assertEqual(pr["BucketEncryption"]["ServerSideEncryptionConfiguration"][0]["ServerSideEncryptionByDefault"], {"SSEAlgorithm": "AES256"})
        self.assertEqual(pr["VersioningConfiguration"], {"Status": "Enabled"})
        rules = {r["Id"]: r for r in pr["LifecycleConfiguration"]["Rules"]}
        self.assertEqual(rules["snapshots-current-30d"]["ExpirationInDays"], 30)
        self.assertEqual(rules["snapshots-current-30d"]["Prefix"], "snapshots/")
        self.assertNotIn("latest.json", str(rules))  # a quiet tree loses its snapshots/latest.json checkpoint after 30 days; the design accepts that
        for rid, prefix in [("snapshots-noncurrent-1d", "snapshots/"), ("render-shadow-noncurrent-1d", "render-shadow/")]:
            self.assertEqual(rules[rid]["Prefix"], prefix)
            self.assertEqual(rules[rid]["NoncurrentVersionExpiration"], {"NoncurrentDays": 1})
            self.assertIs(rules[rid]["ExpiredObjectDeleteMarker"], True)
        for r in rules.values():
            self.assertEqual(r["Status"], "Enabled")
        deny = self.r["SyncBucketPolicy"]["Properties"]["PolicyDocument"]["Statement"][0]
        self.assertEqual((deny["Effect"], deny["Condition"]), ("Deny", {"Bool": {"aws:SecureTransport": "false"}}))

    # AC1: stream, renderer, mapping, DLQ
    def test_table_stream_is_keys_only_and_the_table_is_not_replaced(self):
        t = self.r["Table"]
        self.assertEqual(t["Properties"]["StreamSpecification"], {"StreamViewType": "KEYS_ONLY"})
        self.assertEqual((t["DeletionPolicy"], t["UpdateReplacePolicy"]), ("Retain", "Retain"))
        self.assertEqual(t["Properties"]["TableName"], {"Ref": "TableName"})
        self.assertEqual(t["Properties"]["KeySchema"], [{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}])

    def test_renderer_function(self):
        f = self.r["RenderFunction"]["Properties"]
        self.assertEqual((f["Runtime"], f["Architectures"], f["MemorySize"], f["Timeout"], f["ReservedConcurrentExecutions"]),
                         ("python3.13", ["arm64"], 1024, 300, 1))
        self.assertEqual(f["Code"]["S3Key"], {"Ref": "RenderCodeKey"})
        self.assertEqual(self.p["RenderFunctionName"]["Default"], "hfy-sync-render")

    def test_stream_mapping_is_filtered_to_the_change_log_and_fails_to_a_queue(self):
        m = self.r["RenderStreamMapping"]["Properties"]
        self.assertEqual(m["EventSourceArn"], {"Fn::GetAtt": ["Table", "StreamArn"]})
        self.assertEqual(json.loads(m["FilterCriteria"]["Filters"][0]["Pattern"]), {"dynamodb": {"Keys": {"PK": {"S": ["SYNC#LOG"]}}}})
        self.assertEqual((m["MaximumBatchingWindowInSeconds"], m["MaximumRetryAttempts"], m["BisectBatchOnFunctionError"]), (5, 5, True))
        self.assertEqual(m["DestinationConfig"]["OnFailure"]["Destination"], {"Fn::GetAtt": ["RenderDlq", "Arn"]})

    # HFY-TSK-178: the record-change fan-out consumer
    def test_record_fanout_mapping_wakes_the_api_for_render_outbox_inserts_only(self):
        m = self.r["RecordFanoutMapping"]["Properties"]
        self.assertEqual(m["FunctionName"], {"Ref": "Function"})  # hfy-api, not the renderer
        self.assertEqual(m["EventSourceArn"], {"Fn::GetAtt": ["Table", "StreamArn"]})
        self.assertEqual(json.loads(m["FilterCriteria"]["Filters"][0]["Pattern"]),
                         {"eventName": ["INSERT"], "dynamodb": {"Keys": {"PK": {"S": ["SYNC#RENDERED"]}}}})
        self.assertEqual(m["FunctionResponseTypes"], ["ReportBatchItemFailures"])
        self.assertEqual((m["StartingPosition"], m["MaximumRetryAttempts"]), ("LATEST", 3))
        self.assertNotIn("DestinationConfig", m)

    def test_api_role_reads_only_this_tables_stream_for_the_fanout(self):
        stream = by_sid(self.r["Role"], "RecordFanoutStream")
        self.assertEqual(sorted(stream["Action"]), ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"])
        self.assertEqual(stream["Resource"], {"Fn::GetAtt": ["Table", "StreamArn"]})
        self.assertEqual(stream["Effect"], "Allow")
        self.assertNotIn("Condition", self.r["RecordFanoutMapping"])  # no new parameter: inert until RenderMode is live and recordSubsV1 is on

    # AC1: alarms, AC6: topic + schedule
    def test_every_alarm_notifies_the_topic_and_the_five_named_alarms_exist(self):
        alarms = {n: r["Properties"] for n, r in self.r.items() if r["Type"] == "AWS::CloudWatch::Alarm"}
        self.assertEqual(set(alarms), {"DlqDepthAlarm", "RenderErrorAlarm", "RenderPrivacyBlockAlarm", "MassDeleteGuardAlarm", "HeadMismatchAlarm"})
        for name, a in alarms.items():
            self.assertEqual(a["AlarmActions"], [{"Ref": "AlarmTopic"}], name)
        self.assertEqual({a["MetricName"] for a in alarms.values()},
                         {"ApproximateNumberOfMessagesVisible", "RenderError", "RenderPrivacyBlock", "MassDeleteGuard", "HeadMismatch"})
        self.assertEqual(alarms["DlqDepthAlarm"]["Namespace"], "AWS/SQS")
        for n in ("RenderErrorAlarm", "RenderPrivacyBlockAlarm", "MassDeleteGuardAlarm", "HeadMismatchAlarm"):
            self.assertEqual(alarms[n]["Namespace"], "HFY/SyncRender")

    def test_topic_subscription_is_io_email_from_a_parameter(self):
        sub_ = self.r["AlarmSubscription"]
        self.assertEqual(sub_["Condition"], "HasAlarmEmail")
        self.assertEqual((sub_["Properties"]["Protocol"], sub_["Properties"]["Endpoint"]), ("email", {"Ref": "AlarmEmail"}))
        for name, spec in self.p.items():  # no individual's address lives in the template; SesFromAddress is the generic site sender (default empty)
            self.assertNotIn("@", str(spec.get("Default", "")), name)
        self.assertEqual(self.p["AlarmEmail"]["Default"], "")
        self.assertEqual(self.p["SesFromAddress"]["Default"], "")

    def test_schedule_invokes_the_renderer_every_15_minutes(self):
        rule = self.r["RenderSchedule"]["Properties"]
        self.assertEqual(rule["ScheduleExpression"], "rate(15 minutes)")
        self.assertEqual(rule["Targets"][0]["Arn"], {"Fn::GetAtt": ["RenderFunction", "Arn"]})
        perm = self.r["RenderSchedulePermission"]["Properties"]
        self.assertEqual((perm["Principal"], perm["SourceArn"]), ("events.amazonaws.com", {"Fn::GetAtt": ["RenderSchedule", "Arn"]}))

    # AC2: IAM
    def test_api_role_gains_only_the_media_and_snapshot_grants(self):
        media = by_sid(self.r["Role"], "MediaBinaries")
        # HFY-TSK-173: DeleteObject for the finalized staging object and the key an extension change orphaned
        self.assertEqual(sorted(media["Action"]), ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"])
        self.assertEqual(sub(media["Resource"]), "arn:${AWS::Partition}:s3:::${MediaBucket}/media/*")
        snap = by_sid(self.r["Role"], "SyncSnapshots")
        self.assertEqual(sorted(snap["Action"]), ["s3:GetObject", "s3:PutObject"])
        self.assertEqual(sub(snap["Resource"]), "arn:${AWS::Partition}:s3:::${SyncBucketName}/snapshots/*")

    def test_renderer_role_is_scoped_to_rendered_keys(self):
        data = by_sid(self.r["RenderRole"], "RenderedData")
        self.assertEqual(sorted(data["Action"]), ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"])
        res = sorted(sub(x).split("}/", 1)[1] for x in data["Resource"])
        self.assertEqual(res, sorted(f"{d}/*.json" for d in DATA_PREFIXES))
        self.assertNotIn("person/index.html", str(data))
        lst = by_sid(self.r["RenderRole"], "RenderedDataList")
        self.assertEqual(lst["Action"], "s3:ListBucket")
        prefixes = lst["Condition"]["StringLike"]["s3:prefix"]
        self.assertIn("media/tree_*", prefixes)
        self.assertEqual(sorted(p.split("/")[0] for p in prefixes if p != "media/tree_*"), sorted(DATA_PREFIXES[:-1]))
        self.assertEqual(sorted(by_sid(self.r["RenderRole"], "Stream")["Action"]),
                         ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"])  # ListStreams is not authorized per stream ARN
        sync_list = by_sid(self.r["RenderRole"], "SyncBucketList")
        self.assertEqual(sync_list["Condition"]["StringLike"]["s3:prefix"], ["snapshots/*", "render-shadow/*", "render/*"])
        # table writes are limited to the renderer's own partitions; REC# heads and SYNC#LOG stay read-only
        read = by_sid(self.r["RenderRole"], "TableRead")
        self.assertEqual(sorted(read["Action"]), ["dynamodb:BatchGetItem", "dynamodb:GetItem", "dynamodb:Query"])
        write = by_sid(self.r["RenderRole"], "TableWrite")
        self.assertEqual(write["Condition"], {"ForAllValues:StringEquals": {"dynamodb:LeadingKeys": ["SYNC#RENDER", "SYNC#RENDERED"]}})
        self.assertEqual(write["Resource"], {"Fn::GetAtt": ["Table", "Arn"]})  # no index ARNs: GSIs are never written directly
        self.assertFalse(any(a.startswith("dynamodb:Get") or a == "dynamodb:Query" for a in write["Action"]))
        for s in statements(self.r["RenderRole"]):
            self.assertNotIn("uploads/", str(s.get("Resource")))

    def test_renderer_keys_are_ones_ci_never_syncs(self):
        # scripts/check-deployment-sync.sh and the deploy job exclude the data prefixes, so CI neither overwrites nor deletes renderer output.
        import fnmatch
        manifest = (ROOT / "ci.manifest.yaml").read_text()
        excludes = re.findall(r'^\s+- "(.+)"$', manifest.split("exclude:")[1].split("invalidate:")[0], re.M)
        for d in DATA_PREFIXES:
            probe = f"{d}/x.json"
            self.assertTrue(any(fnmatch.fnmatch(probe, e) for e in excludes), f"{probe} not covered by deploy.exclude")

    def test_edge_and_api_secret_and_mail_grants(self):
        sec = by_sid(self.r["AuthRole"], "AccessRequestSecrets")
        self.assertEqual(sec["Action"], "secretsmanager:GetSecretValue")
        self.assertEqual(sorted(sub(x) for x in sec["Resource"]), sorted(
            f"arn:${{AWS::Partition}}:secretsmanager:${{AWS::Region}}:${{AWS::AccountId}}:secret:${{{n}}}-*" for n in ("TurnstileSecretName", "AccessRequestPepperSecretName")))
        self.assertEqual(self.p["TurnstileSecretName"]["Default"], "harrisonfamily/auth-edge/turnstile")
        self.assertEqual(self.p["AccessRequestPepperSecretName"]["Default"], "harrisonfamily/access-request/pepper")
        # the api role keeps the Cognito and API identity; the edge role sends access-request mail from the JOIN identity only (P2-R23)
        for role, cond, ident, frm, cset in (("Role", "HasSes", "SesIdentityArn", "SesFromAddress", "SesConfigurationSet"),
                                              ("AuthRole", "HasJoinSes", "JoinSesIdentityArn", "JoinFromAddress", "JoinSesConfigurationSet")):
            ses = [s for s in statements(self.r[role]) if isinstance(s, dict) and "Fn::If" in s and s["Fn::If"][0] == cond]
            self.assertEqual(len(ses), 1, role)
            self.assertEqual(len([s for s in statements(self.r[role]) if isinstance(s, dict) and s.get("Fn::If", [""])[0] in ("HasSes", "HasJoinSes")]), 1, role)
            st = ses[0]["Fn::If"][1]
            self.assertEqual((st["Sid"], st["Action"]), ("SendEmail", "ses:SendEmail"))
            self.assertEqual(st["Resource"][0], {"Ref": ident})
            cs = st["Resource"][1]
            if role == "AuthRole":  # required with the identity (rule JoinSesIdentityNeedsConfigurationSet), so no condition around the ARN
                self.assertNotIn("Fn::If", cs)
            else:
                cs = cs["Fn::If"][1]
            self.assertEqual(sub(cs), f"arn:${{AWS::Partition}}:ses:${{AWS::Region}}:${{AWS::AccountId}}:configuration-set/${{{cset}}}", role)
            self.assertEqual(st["Condition"], {"StringEquals": {"ses:FromAddress": {"Ref": frm}}}, role)
            self.assertEqual(ses[0]["Fn::If"][2], {"Ref": "AWS::NoValue"}, role)
        # the edge reads the state of the bounce and complaint alarms: one read-only action. DescribeAlarms is list-style, so an alarm-ARN
        # Resource may not be honored by IAM (AccessDenied would fail the gate closed for good); the resource is "*" and the RG-4 smoke checks it
        alarms = by_sid(self.r["AuthRole"], "JoinMailAlarmState")
        self.assertEqual((alarms["Effect"], alarms["Action"], alarms["Resource"]), ("Allow", "cloudwatch:DescribeAlarms", "*"))
        conds = self.t["Conditions"]
        self.assertEqual(conds["HasJoinSes"], {"Fn::Not": [{"Fn::Equals": [{"Ref": "JoinSesIdentityArn"}, ""]}]})
        self.assertNotIn("HasJoinSesConfigSet", conds)  # the configuration set is required with the identity, never optional
        rules = self.t["Rules"]  # a config set or identity without its companions would fail at runtime, so the template refuses them
        self.assertEqual(rules["SesConfigurationSetNeedsIdentity"]["Assertions"][0]["Assert"], {"Fn::Not": [{"Fn::Equals": [{"Ref": "SesIdentityArn"}, ""]}]})
        self.assertEqual(rules["SesConfigurationSetNeedsIdentity"]["RuleCondition"], {"Fn::Not": [{"Fn::Equals": [{"Ref": "SesConfigurationSet"}, ""]}]})
        self.assertEqual(rules["SesIdentityNeedsFromAddress"]["Assertions"][0]["Assert"], {"Fn::Not": [{"Fn::Equals": [{"Ref": "SesFromAddress"}, ""]}]})
        self.assertEqual(rules["JoinSesIdentityNeedsFromAddress"]["RuleCondition"], {"Fn::Not": [{"Fn::Equals": [{"Ref": "JoinSesIdentityArn"}, ""]}]})
        self.assertEqual(rules["JoinSesIdentityNeedsFromAddress"]["Assertions"][0]["Assert"], {"Fn::Not": [{"Fn::Equals": [{"Ref": "JoinFromAddress"}, ""]}]})
        self.assertEqual(rules["JoinSesIdentityNeedsConfigurationSet"]["RuleCondition"], {"Fn::Not": [{"Fn::Equals": [{"Ref": "JoinSesIdentityArn"}, ""]}]})
        self.assertEqual(rules["JoinSesIdentityNeedsConfigurationSet"]["Assertions"][0]["Assert"], {"Fn::Not": [{"Fn::Equals": [{"Ref": "JoinSesConfigurationSet"}, ""]}]})
        self.assertEqual(rules["JoinSesConfigurationSetNeedsIdentity"]["RuleCondition"], {"Fn::Not": [{"Fn::Equals": [{"Ref": "JoinSesConfigurationSet"}, ""]}]})
        self.assertEqual(rules["JoinSesConfigurationSetNeedsIdentity"]["Assertions"][0]["Assert"], {"Fn::Not": [{"Fn::Equals": [{"Ref": "JoinSesIdentityArn"}, ""]}]})
        for name in ("SesFromAddress", "JoinFromAddress"):
            pattern = re.compile(self.p[name]["AllowedPattern"])
            self.assertTrue(pattern.match("") and pattern.match("no-reply@example.test"), name)
            self.assertIsNone(pattern.match("Site <no-reply@example.test>"), name)

    # AC7: break-glass
    def test_breakglass_role_requires_mfa_and_io_only(self):
        role = self.r["BreakGlassRole"]["Properties"]
        self.assertEqual(role["RoleName"], "hfy-data-breakglass")
        trust = role["AssumeRolePolicyDocument"]["Statement"][0]
        self.assertEqual(trust["Condition"]["Bool"], {"aws:MultiFactorAuthPresent": "true"})
        self.assertEqual(trust["Condition"]["ArnEquals"], {"aws:PrincipalArn": {"Ref": "BreakGlassPrincipalArn"}})
        self.assertLessEqual(role["MaxSessionDuration"], 3600)
        res = sorted(sub(x).split("}/", 1)[1] for x in by_sid(self.r["BreakGlassRole"], "DataPrefixes")["Resource"])
        self.assertEqual(res, sorted(f"{d}/*" for d in DATA_PREFIXES))
        for s in statements(self.r["BreakGlassRole"]):
            self.assertNotIn("config/", str(s.get("Resource")))
            self.assertNotIn("uploads/", str(s.get("Resource")))

    # AC8: graph renderer placeholder
    def test_graph_renderer_placeholder(self):
        f = self.r["GraphRenderFunction"]["Properties"]
        self.assertEqual((f["Runtime"], f["Architectures"], f["ReservedConcurrentExecutions"]), ("nodejs22.x", ["arm64"], 1))
        self.assertEqual(f["Code"]["S3Key"], {"Ref": "GraphRenderCodeKey"})
        # the placeholder role is logs only; viz-graph-cloud-source widens it with the real package
        self.assertEqual([x["Sid"] for x in statements(self.r["GraphRenderRole"])], ["Logs"])
        # nothing invokes it: no event source, schedule target or permission references it
        for n, r in self.r.items():
            if r["Type"] in ("AWS::Lambda::EventSourceMapping", "AWS::Events::Rule", "AWS::Lambda::Permission") and n != "GraphRenderFunction":
                self.assertNotIn("GraphRenderFunction", json.dumps(r), n)

    def test_placeholders_are_no_ops(self):
        import importlib.util
        import os
        from unittest import mock
        path = ROOT / "lambda" / "placeholders" / "hfy-sync-render" / "handler.py"
        py = path.read_text()
        self.assertNotIn("boto3", py)
        self.assertEqual(re.findall(r"^\s*(?:import|from)\s+(\w+)", py, re.M), ["os"])
        spec = importlib.util.spec_from_file_location("hfy_sync_render_placeholder", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        with mock.patch.dict(os.environ, {"RENDER_MODE": "off"}):
            self.assertEqual(mod.handler({}, None), {"status": "noop", "mode": "off"})
        for mode in ("shadow", "live"):
            with mock.patch.dict(os.environ, {"RENDER_MODE": mode}), self.assertRaises(RuntimeError):
                mod.handler({}, None)
        esm = self.r["RenderStreamMapping"]["Properties"]
        self.assertEqual(esm["FunctionResponseTypes"], ["ReportBatchItemFailures"])
        self.assertEqual(esm["MaximumBatchingWindowInSeconds"], 5)
        self.assertEqual(esm["StartingPosition"], "LATEST")
        mjs = (ROOT / "lambda" / "placeholders" / "hfy-graph-render" / "src" / "index.mjs").read_text()
        self.assertNotIn("import", mjs.replace("// Placeholder", ""))
        self.assertEqual(self.r["RenderFunction"]["Properties"]["Handler"], "handler.handler")
        self.assertEqual(self.r["GraphRenderFunction"]["Properties"]["Handler"], "src/index.handler")

    def test_break_glass_principal_has_no_default_and_is_not_in_the_repo(self):
        self.assertNotIn("Default", self.p["BreakGlassPrincipalArn"])  # io's ARN stays out of the repo; every change set passes it (first) or UsePreviousValue (later)
        self.assertNotIn("Conditions", self.r["BreakGlassRole"])

    # AC3: nothing that exists is renamed, removed or re-keyed (a rename or a changed physical name would be a replacement or a Remove)
    def test_existing_resources_and_outputs_are_kept(self):
        kept = {"Table": "AWS::DynamoDB::Table", "LogGroup": "AWS::Logs::LogGroup", "Role": "AWS::IAM::Role", "Function": "AWS::Lambda::Function",
                "FunctionUrl": "AWS::Lambda::Url", "InvokeUrlPermission": "AWS::Lambda::Permission", "InvokeFunctionPermission": "AWS::Lambda::Permission",
                "UploadsResponseHeadersPolicy": "AWS::CloudFront::ResponseHeadersPolicy", "UserPool": "AWS::Cognito::UserPool",
                "UserPoolClient": "AWS::Cognito::UserPoolClient", "AuthLogGroup": "AWS::Logs::LogGroup", "AuthRole": "AWS::IAM::Role",
                "AuthFunction": "AWS::Lambda::Function", "AuthFunctionUrl": "AWS::Lambda::Url", "AuthInvokeUrlPermission": "AWS::Lambda::Permission",
                "AuthInvokeFunctionPermission": "AWS::Lambda::Permission"}
        for name, typ in kept.items():
            self.assertEqual(self.r[name]["Type"], typ, name)
        for name in ("FunctionUrl", "AuthFunctionUrl", "TableName", "FunctionName", "UploadsResponseHeadersPolicyId", "AuthFunctionName", "UserPoolId", "UserPoolClientId"):
            self.assertIn(name, self.t["Outputs"])
        self.assertEqual(self.r["Function"]["Properties"]["FunctionName"], {"Ref": "FunctionName"})
        self.assertEqual(self.r["Role"]["Properties"]["RoleName"], {"Fn::Sub": "${FunctionName}-role"})
        self.assertNotIn("RenderMode", self.t.get("Conditions", {}))  # parameter-only flips: no condition forks resources


class GitHubRoles(unittest.TestCase):
    def test_ci_cannot_delete_or_overwrite_member_uploads(self):
        role = load("github-roles.yaml")["Resources"]["GitHubDeployRole"]
        st = by_sid(role, "ProtectMemberUploads")
        self.assertEqual(st["Effect"], "Deny")
        self.assertEqual(sorted(st["Action"]), ["s3:DeleteObject", "s3:PutObject"])
        self.assertEqual(st["Resource"], ["arn:aws:s3:::harrisonfamily-frontend/uploads/*"])

    def test_deploy_role_names_no_retired_function(self):
        # hfy-check-allowed, its API Gateway and /api/check-allowed were retired on 2026-10-14 (HFY-TSK-326, ruling P2-R48).
        role = load("github-roles.yaml")["Resources"]["GitHubDeployRole"]
        resources = [r["Fn::Sub"] if isinstance(r, dict) else r for r in by_sid(role, "LambdaDeploy")["Resource"]]
        self.assertFalse([r for r in resources if "hfy-check-allowed" in r], resources)
        self.assertEqual(sorted({r.split(":function:")[1].split(":")[0] for r in resources}), ["hfy-api", "hfy-auth-edge"])


if __name__ == "__main__":
    unittest.main()
