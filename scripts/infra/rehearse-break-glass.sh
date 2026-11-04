#!/usr/bin/env bash
# Read-only pre- and post-checks for the break-glass sign-in rehearsal (HFY-TSK-360; ruling P2-R85, P2-R25).
# The rehearsal itself is io's: the MFA device and the assume-role step are io's alone (docs/how-to/rehearse-the-break-glass-sign-in.md).
# This script never signs in for anyone, never assumes a role, never creates or deletes a key, never prints a secret, and mutates nothing:
# every AWS call goes through aws_ro, which refuses any verb that is not on the read-only list below.
#
# Usage: rehearse-break-glass.sh pre  [options]
#        rehearse-break-glass.sh post --assumed-at ISO8601 [options]
#   pre    Before io assumes the role: the role exists; its trust policy names an ARN condition and requires MFA; the session length and
#          the data-prefix grants match the docs; the state of the data-prefix write guard; the principal's row in the credential report.
#   post   After the rehearsal: the session length has passed since --assumed-at (an INFERENCE from the time io supplies and the role's
#          session length; the script cannot see live sessions), the role's last-used time is consistent with that, this shell holds no
#          break-glass credentials, and the principal's access keys are as expected, judged from a credential report generated after the
#          session ended. IAM answers a generate request made within four hours of the previous report with that report, so such a report
#          can exist only four hours after the one the pre-check read. The script never generates one; io does.
# Options:
#   --role-name NAME          default hfy-data-breakglass
#   --bucket NAME             site bucket for the write guard check; default: the bucket the role's own policy names (the stack's MediaBucket).
#                             If given, it must be the bucket the role's policy names, or the pre-check fails.
#   --principal-user NAME     IAM user io signs in as, for the credential report row; default: the user of the current caller identity
#   --expect-active-keys N    post: fail unless the principal has exactly N active access keys (compare with the count the pre-check printed);
#                             it also fails when no fresh credential report can be read, so it never passes without checking the keys
#   --assumed-at ISO8601      post (required): UTC time io ran assume-role, for example 2026-11-20T17:05:00Z
#   --now ISO8601             override the clock; test-only, refused unless HFY_TEST_CLOCK=1 is set
#   --help
# Exit: 0 every check passed (WARN lines do not fail), 1 a check failed, 2 usage error.
# Needs aws, jq, python3. Prints no secret and no account id; the principal ARN named in the trust condition is reported as present, not shown.
set -euo pipefail
umask 077

ROLE=hfy-data-breakglass; BUCKET=""; USER_NAME=""; EXPECT_KEYS=""; ASSUMED_AT=""; NOW=""; MODE=""
EXPECT_SESSION=3600
usage() { awk 'NR > 1 { if (/^#/) print; else exit }' "$0" | sed 's/^# \{0,1\}//'; }

if [ $# -eq 0 ]; then usage >&2; exit 2; fi
case "$1" in
  pre|post) MODE=$1; shift;;
  --help|-h) usage; exit 0;;
  *) echo "unknown mode $1 (use pre or post)" >&2; exit 2;;
esac
while [ $# -gt 0 ]; do case "$1" in
  --role-name) ROLE=${2-}; [ -n "${2-}" ] || { echo "--role-name needs a value" >&2; exit 2; }; shift;;
  --bucket) BUCKET=${2-}; [ -n "${2-}" ] || { echo "--bucket needs a value" >&2; exit 2; }; shift;;
  --principal-user) USER_NAME=${2-}; [ -n "${2-}" ] || { echo "--principal-user needs a value" >&2; exit 2; }; shift;;
  --expect-active-keys) EXPECT_KEYS=${2-}; [ -n "${2-}" ] || { echo "--expect-active-keys needs a value" >&2; exit 2; }; shift;;
  --assumed-at) ASSUMED_AT=${2-}; [ -n "${2-}" ] || { echo "--assumed-at needs a value" >&2; exit 2; }; shift;;
  --now) NOW=${2-}; [ -n "${2-}" ] || { echo "--now needs a value" >&2; exit 2; }; shift;;
  --help|-h) usage; exit 0;;
  *) echo "unknown arg $1" >&2; exit 2;; esac; shift; done
case "$EXPECT_KEYS" in ""|[0-2]) ;; *) echo "--expect-active-keys must be 0, 1 or 2" >&2; exit 2;; esac
if [ -n "$NOW" ] && [ "${HFY_TEST_CLOCK:-}" != 1 ]; then echo "--now is test-only: it needs HFY_TEST_CLOCK=1" >&2; exit 2; fi
if [ "$MODE" = post ] && [ -z "$ASSUMED_AT" ]; then echo "post needs --assumed-at (UTC, ISO 8601)" >&2; exit 2; fi
if [ "$MODE" = pre ] && { [ -n "$ASSUMED_AT" ] || [ -n "$EXPECT_KEYS" ]; }; then echo "--assumed-at and --expect-active-keys belong to post" >&2; exit 2; fi

# The only AWS verbs this script may call. Anything else is refused before it reaches the CLI.
aws_ro() { # SERVICE VERB ARGS...
  case "$1 $2" in
    "sts get-caller-identity"|"iam get-role"|"iam list-role-policies"|"iam get-role-policy"|"iam get-credential-report"|"s3api get-bucket-policy") ;;
    *) echo "refusing non-read-only AWS call: $1 $2" >&2; exit 2;;
  esac
  aws "$@"
}

PASS=0; FAIL=0; WARN=0
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$*"; }
warn() { WARN=$((WARN + 1)); printf 'WARN  %s\n' "$*"; }
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT

epoch() { python3 -I -c 'import sys,datetime,re
s=sys.argv[1].strip()
s=re.sub(r"\.[0-9]+","",s)
s=re.sub(r"(Z|\+00:?00)$","Z",s)
try: d=datetime.datetime.strptime(s,"%Y-%m-%dT%H:%M:%SZ")
except ValueError: sys.exit(1)
print(int((d-datetime.datetime(1970,1,1)).total_seconds()))' "$1"; }

echo "break-glass rehearsal $MODE-check (read-only; role $ROLE)"

# Who is this shell? Only the shape is used; the account id and ARN are never printed.
if ! IDENT=$(aws_ro sts get-caller-identity --query Arn --output text 2>"$W/err"); then
  fail "caller identity: no usable AWS credentials in this shell"; echo "summary: $PASS passed, $FAIL failed, $WARN warnings"; exit 1
fi
IDENT_KIND=other
case "$IDENT" in
  *:user/*) IDENT_KIND=user; [ -n "$USER_NAME" ] || USER_NAME=${IDENT##*/};;
  *:assumed-role/"$ROLE"/*) IDENT_KIND=breakglass;;
  *:assumed-role/*) IDENT_KIND=role;;
esac

if [ "$MODE" = pre ]; then
  if [ "$IDENT_KIND" = breakglass ]; then fail "this shell already holds a $ROLE session; start the rehearsal from io's usual credentials"
  else pass "this shell uses io's usual credentials ($IDENT_KIND), not a $ROLE session"; fi

  # 1. The role exists, and its trust policy matches the docs.
  if aws_ro iam get-role --role-name "$ROLE" --output json > "$W/role.json" 2>"$W/err"; then
    pass "the role $ROLE exists"
    SESS=$(jq -r '.Role.MaxSessionDuration // 0' "$W/role.json")
    if [ "$SESS" = "$EXPECT_SESSION" ]; then pass "MaxSessionDuration is $EXPECT_SESSION seconds (one hour)"
    else fail "MaxSessionDuration is $SESS seconds, the docs say $EXPECT_SESSION"; fi
    TRUST=$(jq -c '.Role.AssumeRolePolicyDocument' "$W/role.json")
    CHECK=$(jq -r '
      [.Statement] | flatten | map(select(.Effect == "Allow")) as $a
      | ($a | length) as $n
      | ($a | map(select((.Action == "sts:AssumeRole") or ((.Action | type) == "array" and (.Action | index("sts:AssumeRole")))))) as $assume
      | ($assume | map(select((.Condition.Bool["aws:MultiFactorAuthPresent"] // "") | tostring | . == "true"))) as $mfa
      | ($assume | map(select((.Condition.ArnEquals["aws:PrincipalArn"] // "") != ""))) as $arn
      | ($arn | map(select([.Condition.ArnEquals["aws:PrincipalArn"] | if type == "array" then .[] else . end]
          | all(type == "string" and length > 0 and (contains("*") | not))))) as $arnok
      | ($assume | map(select((.Principal | type) == "object" and ([.Principal.AWS | if type == "array" then .[] else . end] | length == 1)
          and ([.Principal.AWS | if type == "array" then .[] else . end][0] | type == "string" and test("^arn:[^:]*:iam::[0-9]{12}:root$"))))) as $root
      | "\($n) \($assume | length) \($mfa | length) \($arn | length) \($arnok | length) \($root | length)"' <<<"$TRUST")
    read -r N_ALLOW N_ASSUME N_MFA N_ARN N_ARNOK N_ROOT <<<"$CHECK"
    if [ "$N_ALLOW" = 1 ] && [ "$N_ASSUME" = 1 ]; then pass "the trust policy has one Allow statement, for sts:AssumeRole"
    else fail "the trust policy should have exactly one Allow statement, for sts:AssumeRole (found $N_ALLOW allow, $N_ASSUME assume)"; fi
    if [ "$N_MFA" -ge 1 ]; then pass "the trust condition requires aws:MultiFactorAuthPresent = true"
    else fail "the trust condition does not require MFA"; fi
    if [ "$N_ARN" -ge 1 ]; then pass "the trust condition pins aws:PrincipalArn (value not shown)"
    else fail "the trust condition does not pin the principal ARN"; fi
    if [ "$N_ARN" -ge 1 ] && [ "$N_ARNOK" = "$N_ARN" ]; then pass "the pinned principal ARN is non-empty and has no wildcard"
    elif [ "$N_ARN" -ge 1 ]; then fail "the pinned principal ARN is empty or contains a wildcard"; fi
    if [ "$N_ROOT" -ge 1 ]; then pass "the trust principal is the account root (the condition does the narrowing)"
    else fail "the trust principal is not the account root"; fi
  else
    fail "the role $ROLE could not be read (missing, or this identity may not read it)"
  fi

  # 2. The inline policy: data prefixes only.
  if aws_ro iam list-role-policies --role-name "$ROLE" --output json > "$W/pols.json" 2>"$W/err"; then
    if jq -e --arg r "$ROLE" '.PolicyNames | index($r)' "$W/pols.json" >/dev/null; then
      if aws_ro iam get-role-policy --role-name "$ROLE" --policy-name "$ROLE" --output json > "$W/pol.json" 2>"$W/err"; then
        # Exact scope: every Allow Resource is one of the six data-prefix ARNs or the bucket ARN itself, all in one bucket, and only the
        # three statements the stack defines are present. The bucket is read from the policy (the stack's MediaBucket).
        PBASE=$(jq -r '[.PolicyDocument.Statement[] | (.Resource | if type == "array" then .[] else . end)
          | select(type == "string" and test("^arn:[^:]*:s3:::[^/*]+/person/\\*$")) | sub("/person/\\*$"; "")] | first // ""' "$W/pol.json")
        if [ -z "$PBASE" ]; then fail "the inline policy does not grant the person/ prefix of one bucket: bucket unknown"
        else
          POL_BUCKET=${PBASE##*:::}
          if [ -z "$BUCKET" ]; then BUCKET=$POL_BUCKET; echo "INFO  site bucket taken from the role's policy (name not repeated here)"
          elif [ "$BUCKET" != "$POL_BUCKET" ]; then fail "--bucket is not the bucket the role's policy names; the guard check would look at the wrong bucket"; fi
          EXTRA=$(jq -r --arg b "$PBASE" '[.PolicyDocument.Statement[] | select(.Effect == "Allow") | (.Resource | if type == "array" then .[] else . end)]
            | map(. as $x | select($x != $b and ([$b + "/person/*", $b + "/family/*", $b + "/event/*", $b + "/note/*", $b + "/place/*", $b + "/media/*"] | index($x) | not)))
            | length' "$W/pol.json")
          BADSID=$(jq -r '[.PolicyDocument.Statement[] | select((.Sid // "") as $s | ["DataPrefixes","DataPrefixList","VersioningStatus"] | index($s) | not)] | length' "$W/pol.json")
          MISS=""
          for p in person family event note place media; do
            jq -e --arg r "$PBASE/$p/*" '[.PolicyDocument.Statement[] | (.Resource | if type == "array" then .[] else . end)] | index($r)' "$W/pol.json" >/dev/null || MISS="$MISS $p"
          done
          if [ -z "$MISS" ]; then pass "the inline policy grants the six data prefixes"; else fail "the inline policy lacks the prefix(es):$MISS"; fi
          if [ "$EXTRA" = 0 ]; then pass "every Allow resource of the inline policy is a data prefix or the bucket itself, in one bucket"
          else fail "the inline policy allows $EXTRA resource(s) beyond the six data prefixes and the bucket (uploads, another bucket, table, sync)"; fi
          if [ "$BADSID" = 0 ]; then pass "the inline policy has only the DataPrefixes, DataPrefixList and VersioningStatus statements"
          else fail "the inline policy has $BADSID statement(s) other than DataPrefixes, DataPrefixList and VersioningStatus"; fi
        fi
        if jq -e '[.PolicyDocument.Statement[] | select(.Effect == "Allow") | (.Action | if type == "array" then .[] else . end)] | any(. == "*" or . == "s3:*")' "$W/pol.json" >/dev/null; then
          fail "the inline policy allows a wildcard action"; else pass "the inline policy has no wildcard action"; fi
      else fail "the inline policy $ROLE could not be read"; fi
    else fail "the role has no inline policy named $ROLE"; fi
  else fail "the role's inline policies could not be listed"; fi

  # 3. The data-prefix write guard on the site bucket. The exemption is by role name: apply-data-write-guard.sh puts hfy-data-breakglass
  #    in the ArnNotLike list of aws:PrincipalArn patterns, so the role name appears in the Records statement's condition.
  if [ -z "$BUCKET" ]; then fail "the site bucket is unknown (the role's policy could not be read), so the write guard was not checked; pass --bucket"
  elif aws_ro s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text > "$W/bp.txt" 2>"$W/err"; then
    GS=$(jq -r '[.Statement[]? | select(.Sid == "HfyDataWriteGuardRecords" or .Sid == "HfyDataWriteGuardMediaDelete")] | length' "$W/bp.txt" 2>/dev/null || echo bad)
    case "$GS" in
      2) pass "the data-prefix write guard is applied (both statements present)"
         if jq -e --arg r "$ROLE" '[.Statement[] | select(.Sid == "HfyDataWriteGuardRecords") | (.Condition | tostring)] | any(contains($r))' "$W/bp.txt" >/dev/null; then
           pass "the guard exempts $ROLE"; else fail "the guard does not name $ROLE as an exception"; fi;;
      0) warn "the data-prefix write guard is not applied: the rehearsal can only show that the role can assume and read, not that it is the one path through the guard";;
      1) fail "only one of the two guard statements is present";;
      *) fail "the bucket policy could not be parsed";;
    esac
  else
    if grep -q NoSuchBucketPolicy "$W/err"; then warn "the bucket has no policy, so the write guard is not applied"
    else fail "the bucket policy could not be read"; fi
  fi
fi

# 4. The credential report row of the principal (pre and post). The script never generates a report.
if [ -n "$USER_NAME" ]; then
  if aws_ro iam get-credential-report --query Content --output text > "$W/cr.b64" 2>"$W/err"; then
    GEN=$(aws_ro iam get-credential-report --query GeneratedTime --output text 2>/dev/null || true)
    GEN_T=""; [ -n "$GEN" ] && GEN_T=$(epoch "$GEN" 2>/dev/null) || GEN_T=""
    if [ -n "$GEN_T" ]; then echo "INFO  credential report generated at $(date -u -r "$GEN_T" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "$GEN") (a cached snapshot, up to 4 hours old)"
    else warn "the credential report has no readable generation time, so its age is unknown"; fi
    python3 -I -c 'import sys,base64
sys.stdout.write(base64.b64decode(open(sys.argv[1]).read().strip()).decode())' "$W/cr.b64" > "$W/cr.csv" 2>/dev/null || : > "$W/cr.csv"
    ROW=$(python3 -I - "$W/cr.csv" "$USER_NAME" <<'PY'
import csv, sys
rows = list(csv.DictReader(open(sys.argv[1])))
for r in rows:
    if r.get("user") == sys.argv[2]:
        k = sum(1 for n in ("access_key_1_active", "access_key_2_active") if r.get(n) == "true")
        print(f'{r.get("mfa_active")} {k} {r.get("password_enabled")}')
        break
else:
    print("none")
PY
)
    if [ "$ROW" = none ] || [ -z "$ROW" ]; then fail "the credential report has no row for the principal user"
    else
      read -r R_MFA ACTIVE_KEYS _ <<<"$ROW"
      if [ "$R_MFA" = true ]; then pass "credential report: MFA is active for the principal"; else fail "credential report: MFA is not active for the principal"; fi
      echo "INFO  credential report: $ACTIVE_KEYS active access key(s) for the principal"
      REPORT_FRESH=unknown
      if [ "$MODE" = post ]; then
        # Fresh means generated after the session could have ended; an older report cannot show what the rehearsal left behind.
        T0R=$(epoch "$ASSUMED_AT") || { echo "--assumed-at must look like 2026-11-20T17:05:00Z" >&2; exit 2; }
        if [ -n "$GEN_T" ] && [ "$GEN_T" -gt $((T0R + EXPECT_SESSION)) ]; then REPORT_FRESH=yes; else REPORT_FRESH=no; fi
        if [ "$REPORT_FRESH" = no ]; then
          # IAM returns the previous report for any request within four hours of it, so generating one does not help until the previous
          # report is four hours old. The generation time of the report this run read is printed above.
          STALE_HINT="IAM answers a generate request made within four hours of the previous report with that same report: once the generation time printed above is four hours old and the session has ended, io runs IAM generate-credential-report, waits for COMPLETE and reruns; this script never generates one"
          if [ -n "$EXPECT_KEYS" ]; then fail "the credential report predates the end of the session (or its time is unknown), so the key count was not checked: $STALE_HINT"
          else warn "the credential report may predate the end of the session: $STALE_HINT"; fi
        fi
      fi
      if [ "$MODE" = post ] && [ -n "$EXPECT_KEYS" ] && [ "$REPORT_FRESH" = yes ]; then
        if [ "$ACTIVE_KEYS" = "$EXPECT_KEYS" ]; then pass "the principal has the expected $EXPECT_KEYS active access key(s): none was left behind"
        else fail "the principal has $ACTIVE_KEYS active access key(s), expected $EXPECT_KEYS"; fi
      fi
    fi
  elif [ "$MODE" = post ] && [ -n "$EXPECT_KEYS" ]; then
    fail "no credential report could be read (none generated, expired, or this identity may not read it), so --expect-active-keys was not checked: io runs IAM generate-credential-report, waits for COMPLETE and reruns; this script never generates one"
  else
    warn "no credential report is available; io may generate one (IAM generate-credential-report) and rerun. This script does not."
  fi
elif [ "$MODE" = pre ]; then
  warn "the caller is not an IAM user and --principal-user was not given: credential report row skipped"
elif [ "$MODE" = post ] && [ -n "$EXPECT_KEYS" ]; then
  fail "--expect-active-keys needs the principal's credential report row: pass --principal-user"
fi

if [ "$MODE" = post ]; then
  # 5. The session has ended: the session length has passed since io assumed the role.
  T0=$(epoch "$ASSUMED_AT") || { echo "--assumed-at must look like 2026-11-20T17:05:00Z" >&2; exit 2; }
  if [ -n "$NOW" ]; then T1=$(epoch "$NOW") || { echo "--now must look like 2026-11-20T17:05:00Z" >&2; exit 2; }
  else T1=$(date -u +%s); fi
  SESS=$EXPECT_SESSION
  if aws_ro iam get-role --role-name "$ROLE" --output json > "$W/role.json" 2>"$W/err"; then SESS=$(jq -r '.Role.MaxSessionDuration // 3600' "$W/role.json"); fi
  AGE=$((T1 - T0))
  if [ "$AGE" -lt 0 ]; then fail "--assumed-at is in the future"
  elif [ "$AGE" -ge "$SESS" ]; then pass "the session has expired: $AGE seconds since assume-role, the session length is $SESS"
  else fail "the session may still be live: $AGE of $SESS seconds have passed; wait until it expires, or end the shell that holds it"; fi
  if jq -e '.Role.RoleLastUsed.LastUsedDate' "$W/role.json" >/dev/null 2>&1; then
    LU=$(jq -r '.Role.RoleLastUsed.LastUsedDate' "$W/role.json")
    echo "INFO  role last used: $LU (record on HFY-TSK-247; a timestamp, not a secret)"
    # Cross-check of the inference: RoleLastUsed is recorded when the role's permissions are used (and can lag by hours).
    if LU_T=$(epoch "$LU" 2>/dev/null); then
      if [ "$LU_T" -gt $((T0 + SESS)) ]; then warn "the role was last used after the session should have ended (assumed-at plus $SESS seconds): check --assumed-at, and whether another session exists"
      elif [ "$LU_T" -lt "$T0" ]; then warn "the role was last used before --assumed-at: check --assumed-at, or note that last-used can lag"
      else pass "the role's last-used time falls inside the expected session window"; fi
    else warn "the role's last-used time could not be read"; fi
  else
    warn "the role has no last-used time: the session may not have used the role's permissions (io's step 4 read), or the time lags"
  fi
  # 6. No break-glass credentials remain in this shell.
  if [ "$IDENT_KIND" = breakglass ]; then fail "this shell still holds a $ROLE session: unset the AWS_* credential variables and close the shell"
  else pass "this shell does not hold a $ROLE session"; fi
  LEFT=""
  for v in EXPUNGE_SITE_AWS_ACCESS_KEY_ID EXPUNGE_SITE_AWS_SECRET_ACCESS_KEY EXPUNGE_SITE_AWS_SESSION_TOKEN; do
    if [ -n "${!v:-}" ]; then LEFT="$LEFT $v"; fi
  done
  if [ -z "$LEFT" ]; then pass "no EXPUNGE_SITE_AWS_* variable is set in this shell"; else fail "still set in this shell (names only):$LEFT"; fi
  if [ -n "${AWS_SESSION_TOKEN:-}" ] && [ "$IDENT_KIND" != user ]; then
    warn "AWS_SESSION_TOKEN is set in this shell; confirm it is io's usual session and not a leftover rehearsal session"; fi
fi

echo "summary: $PASS passed, $FAIL failed, $WARN warnings"
[ "$FAIL" = 0 ]
