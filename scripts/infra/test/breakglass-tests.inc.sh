# shellcheck shell=bash
# shellcheck disable=SC2034 # CURRENT is read by run.sh's fail()
# Sourced by run.sh: tests for rehearse-break-glass.sh (HFY-TSK-360). Uses run.sh's helpers (new_stub, eq, contains, lacks, check)
# and variables (T, INFRA, STUB_BIN, STUB_DIR, CURRENT). Everything runs against the aws stub: nothing reaches AWS.
BG=rehearse-break-glass.sh
BG_ROLE_ARN_VALUE="arn:aws:iam::123456789012:user/io-example"
bg_run() { # ARGS... : run the script against the stub (new_stub must have run); sets OUT and RC
  set +e; OUT=$(PATH="$STUB_BIN:$PATH" "$INFRA/$BG" "$@" 2>&1); RC=$?; set -e
}
bg_seed() { # seeds a healthy role, policy, bucket policy and credential report in $STUB_DIR
  jq -n --arg p "$BG_ROLE_ARN_VALUE" '{Role: {RoleName: "hfy-data-breakglass", MaxSessionDuration: 3600,
    AssumeRolePolicyDocument: {Version: "2012-10-17", Statement: [{Effect: "Allow", Principal: {AWS: "arn:aws:iam::123456789012:root"}, Action: "sts:AssumeRole",
      Condition: {ArnEquals: {"aws:PrincipalArn": $p}, Bool: {"aws:MultiFactorAuthPresent": "true"}}}]}}}' > "$STUB_DIR/bg-role.json"
  echo '{"PolicyNames":["hfy-data-breakglass"]}' > "$STUB_DIR/bg-policies.json"
  jq -n '{PolicyDocument: {Version: "2012-10-17", Statement: [
    {Sid: "DataPrefixes", Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
     Resource: ["person","family","event","note","place","media"] | map("arn:aws:s3:::harrisonfamily-frontend/\(.)/*")},
    {Sid: "VersioningStatus", Effect: "Allow", Action: "s3:GetBucketVersioning", Resource: "arn:aws:s3:::harrisonfamily-frontend"}]}}' > "$STUB_DIR/bg-policy.json"
  printf 'user,arn,password_enabled,mfa_active,access_key_1_active,access_key_2_active\nio-example,arn:x,true,true,true,false\n' | base64 | tr -d '\n' > "$STUB_DIR/cred-report.b64"
}
bg_guard() { # applies the real guard policy (dry run, offline) as the stub's bucket policy
  "$INFRA/apply-data-write-guard.sh" --dry-run --policy-file /dev/null --account-id "$ACCT_BG" 2>/dev/null | sed -n '/^{/,/^}/p' | jq -c . > "$STUB_DIR/bucket-policy.json" || true
}
ACCT_BG=123456789012
MUTATING='create-\|delete-\|put-\|update-\|attach-\|detach-\|assume-role\|generate-credential\|add-\|remove-\|set-\|tag-\|untag-\|reset-\|deactivate-\|upload-'

CURRENT="break-glass rehearsal: argument handling"
new_stub
bg_run
eq "no arguments is a usage error" "$RC" 2
bg_run bogus
eq "unknown mode" "$RC" 2
bg_run pre --bogus
eq "unknown option" "$RC" 2
bg_run post
eq "post needs --assumed-at" "$RC" 2
bg_run pre --assumed-at 2026-01-01T00:00:00Z
eq "pre refuses --assumed-at" "$RC" 2
bg_run pre --expect-active-keys 9
eq "--expect-active-keys is 0 to 2" "$RC" 2
bg_run pre --role-name
eq "an option without a value" "$RC" 2
bg_run --help
eq "--help exits 0" "$RC" 0
contains "--help prints usage" "$OUT" "Usage: rehearse-break-glass.sh pre"
check "no AWS call was made by any refusal" test ! -f "$STUB_DIR/calls.log"
bg_seed; bg_run post --assumed-at yesterday
eq "post refuses a malformed --assumed-at" "$RC" 2

CURRENT="break-glass rehearsal: pre-check passes on a healthy setup"
new_stub; bg_seed; bg_guard
bg_run pre --bucket harrisonfamily-frontend
eq "healthy pre-check exits 0" "$RC" 0
contains "role exists" "$OUT" "PASS  the role hfy-data-breakglass exists"
contains "MFA condition" "$OUT" "requires aws:MultiFactorAuthPresent = true"
contains "principal pinned, value hidden" "$OUT" "pins aws:PrincipalArn (value not shown)"
contains "six prefixes" "$OUT" "grants the six data prefixes"
contains "guard applied" "$OUT" "write guard is applied"
contains "guard exempts break-glass" "$OUT" "the guard exempts hfy-data-breakglass"
contains "credential report" "$OUT" "1 active access key(s)"
lacks "the account id is never printed" "$OUT" "123456789012"
lacks "the principal ARN is never printed" "$OUT" "io-example"
contains "summary" "$OUT" "0 failed"

CURRENT="break-glass rehearsal: pre-check failures"
new_stub; bg_seed; bg_guard
jq 'del(.Role.AssumeRolePolicyDocument.Statement[0].Condition.Bool)' "$STUB_DIR/bg-role.json" > "$STUB_DIR/x" && mv "$STUB_DIR/x" "$STUB_DIR/bg-role.json"
bg_run pre
eq "a trust policy without MFA fails" "$RC" 1
contains "names the MFA failure" "$OUT" "FAIL  the trust condition does not require MFA"
new_stub; bg_seed; bg_guard
jq '.Role.MaxSessionDuration = 43200' "$STUB_DIR/bg-role.json" > "$STUB_DIR/x" && mv "$STUB_DIR/x" "$STUB_DIR/bg-role.json"
bg_run pre
eq "a longer session fails" "$RC" 1
new_stub; bg_seed; bg_guard
jq '.PolicyDocument.Statement[0].Resource += ["arn:aws:s3:::harrisonfamily-frontend/uploads/*"]' "$STUB_DIR/bg-policy.json" > "$STUB_DIR/x" && mv "$STUB_DIR/x" "$STUB_DIR/bg-policy.json"
bg_run pre
eq "a policy that reaches uploads/ fails" "$RC" 1
new_stub
bg_run pre
eq "a missing role fails" "$RC" 1
contains "missing role named" "$OUT" "FAIL  the role hfy-data-breakglass could not be read"
new_stub; bg_seed; rm -f "$STUB_DIR/bucket-policy.json"
bg_run pre
eq "no bucket policy is a warning, not a failure" "$RC" 0
contains "guard-not-applied warning" "$OUT" "WARN  the bucket has no policy"
new_stub; bg_seed; bg_guard; printf 'user,arn,password_enabled,mfa_active,access_key_1_active,access_key_2_active\nio-example,arn:x,true,false,false,false\n' | base64 | tr -d '\n' > "$STUB_DIR/cred-report.b64"
bg_run pre
eq "MFA inactive in the credential report fails" "$RC" 1
new_stub; bg_seed; bg_guard; echo "arn:aws:sts::123456789012:assumed-role/hfy-data-breakglass/rehearsal" > "$STUB_DIR/caller-arn"
bg_run pre
eq "starting from a break-glass session fails" "$RC" 1

CURRENT="break-glass rehearsal: post-check"
new_stub; bg_seed
bg_run post --assumed-at 2026-11-20T17:00:00Z --now 2026-11-20T18:30:00Z --expect-active-keys 1
eq "an expired session with the expected keys passes" "$RC" 0
contains "expired" "$OUT" "the session has expired"
contains "keys as expected" "$OUT" "none was left behind"
bg_run post --assumed-at 2026-11-20T17:00:00Z --now 2026-11-20T17:30:00Z
eq "a session inside its hour fails" "$RC" 1
contains "may still be live" "$OUT" "may still be live"
bg_run post --assumed-at 2026-11-20T17:00:00Z --now 2026-11-20T18:30:00Z --expect-active-keys 0
eq "an unexpected active key fails" "$RC" 1
set +e; OUT=$(EXPUNGE_SITE_AWS_SESSION_TOKEN=tok-must-not-print PATH="$STUB_BIN:$PATH" "$INFRA/$BG" post --assumed-at 2026-11-20T17:00:00Z --now 2026-11-20T18:30:00Z 2>&1); RC=$?; set -e
eq "a leftover EXPUNGE_SITE variable fails" "$RC" 1
contains "names the variable" "$OUT" "EXPUNGE_SITE_AWS_SESSION_TOKEN"
lacks "never prints the value" "$OUT" "tok-must-not-print"
echo "arn:aws:sts::123456789012:assumed-role/hfy-data-breakglass/rehearsal" > "$STUB_DIR/caller-arn"
bg_run post --assumed-at 2026-11-20T17:00:00Z --now 2026-11-20T18:30:00Z
eq "a shell still holding the break-glass session fails" "$RC" 1

CURRENT="break-glass rehearsal: read-only"
check "no AWS call in any run used a mutating verb" bash -c "! grep -qE '^(iam|sts|s3api|s3|cloudfront|cloudformation|secretsmanager) ($MUTATING)' '$STUB_DIR/calls.log'"
check "the script never calls assume-role" bash -c "! grep -q 'assume-role' '$STUB_DIR/calls.log'"
check "the script source names no mutating AWS verb" bash -c "! grep -E '^[^#]*aws(_ro)? +(iam|sts|s3api) +($MUTATING)' '$INFRA/$BG'"
check "every aws call goes through the read-only wrapper" bash -c "[ \"\$(grep -cE '^[^#]*[^_a-z]aws [a-z]' '$INFRA/$BG')\" = 1 ]"
check "the doc and script carry no 12-digit account id" bash -c "! grep -E '[^0-9][0-9]{12}[^0-9]' '$INFRA/$BG' '$ROOT/docs/how-to/rehearse-the-break-glass-sign-in.md'"
