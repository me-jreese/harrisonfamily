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
#   post   After the rehearsal: the session has ended (the session length has passed since --assumed-at), this shell holds no break-glass
#          credentials, and the principal's access keys are as expected.
# Options:
#   --role-name NAME          default hfy-data-breakglass
#   --bucket NAME             site bucket for the write guard check; default harrisonfamily-frontend (the s3_static bucket of ci.manifest.yaml)
#   --principal-user NAME     IAM user io signs in as, for the credential report row; default: the user of the current caller identity
#   --expect-active-keys N    post: fail unless the principal has exactly N active access keys (compare with the count the pre-check printed)
#   --assumed-at ISO8601      post (required): UTC time io ran assume-role, for example 2026-11-20T17:05:00Z
#   --now ISO8601             override the clock (tests)
#   --help
# Exit: 0 every check passed (WARN lines do not fail), 1 a check failed, 2 usage error.
# Needs aws, jq, python3. Prints no secret and no account id; the principal ARN named in the trust condition is reported as present, not shown.
set -euo pipefail
umask 077

ROLE=hfy-data-breakglass; BUCKET=harrisonfamily-frontend; USER_NAME=""; EXPECT_KEYS=""; ASSUMED_AT=""; NOW=""; MODE=""
EXPECT_SESSION=3600
usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; }

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

epoch() { python3 -I -c 'import sys,datetime
s=sys.argv[1]
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
      | "\($n) \($assume | length) \($mfa | length) \($arn | length)"' <<<"$TRUST")
    read -r N_ALLOW N_ASSUME N_MFA N_ARN <<<"$CHECK"
    if [ "$N_ALLOW" = 1 ] && [ "$N_ASSUME" = 1 ]; then pass "the trust policy has one Allow statement, for sts:AssumeRole"
    else fail "the trust policy should have exactly one Allow statement, for sts:AssumeRole (found $N_ALLOW allow, $N_ASSUME assume)"; fi
    if [ "$N_MFA" -ge 1 ]; then pass "the trust condition requires aws:MultiFactorAuthPresent = true"
    else fail "the trust condition does not require MFA"; fi
    if [ "$N_ARN" -ge 1 ]; then pass "the trust condition pins aws:PrincipalArn (value not shown)"
    else fail "the trust condition does not pin the principal ARN"; fi
  else
    fail "the role $ROLE could not be read (missing, or this identity may not read it)"
  fi

  # 2. The inline policy: data prefixes only.
  if aws_ro iam list-role-policies --role-name "$ROLE" --output json > "$W/pols.json" 2>"$W/err"; then
    if jq -e --arg r "$ROLE" '.PolicyNames | index($r)' "$W/pols.json" >/dev/null; then
      if aws_ro iam get-role-policy --role-name "$ROLE" --policy-name "$ROLE" --output json > "$W/pol.json" 2>"$W/err"; then
        RES=$(jq -r '[.PolicyDocument.Statement[] | (.Resource | if type == "array" then .[] else . end)] | join(" ")' "$W/pol.json")
        MISS=""
        for p in person family event note place media; do case "$RES" in *"/$p/*"*) ;; *) MISS="$MISS $p";; esac; done
        if [ -z "$MISS" ]; then pass "the inline policy grants the six data prefixes"; else fail "the inline policy lacks the prefix(es):$MISS"; fi
        case "$RES" in *uploads*|*dynamodb*|*sync*) fail "the inline policy reaches beyond the data prefixes (uploads, table or sync bucket)";;
          *) pass "the inline policy does not reach uploads/, the table or the sync bucket";; esac
        if jq -e '[.PolicyDocument.Statement[] | select(.Effect == "Allow") | (.Action | if type == "array" then .[] else . end)] | any(. == "*" or . == "s3:*")' "$W/pol.json" >/dev/null; then
          fail "the inline policy allows a wildcard action"; else pass "the inline policy has no wildcard action"; fi
      else fail "the inline policy $ROLE could not be read"; fi
    else fail "the role has no inline policy named $ROLE"; fi
  else fail "the role's inline policies could not be listed"; fi

  # 3. The data-prefix write guard on the site bucket.
  if aws_ro s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text > "$W/bp.txt" 2>"$W/err"; then
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
      if [ "$MODE" = post ] && [ -n "$EXPECT_KEYS" ]; then
        if [ "$ACTIVE_KEYS" = "$EXPECT_KEYS" ]; then pass "the principal has the expected $EXPECT_KEYS active access key(s): none was left behind"
        else fail "the principal has $ACTIVE_KEYS active access key(s), expected $EXPECT_KEYS"; fi
      fi
    fi
  else
    warn "no credential report is available; io may generate one (aws iam generate-credential-report) and rerun. This script does not."
  fi
elif [ "$MODE" = pre ]; then
  warn "the caller is not an IAM user and --principal-user was not given: credential report row skipped"
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
    echo "INFO  role last used: $(jq -r '.Role.RoleLastUsed.LastUsedDate' "$W/role.json") (record on HFY-TSK-247; a timestamp, not a secret)"
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
