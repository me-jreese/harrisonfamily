# shellcheck shell=bash
# shellcheck disable=SC2034 # CURRENT is read by run.sh's fail()
# Sourced by run.sh: tests for apply-data-write-guard.sh and its runbook (HFY-TSK-151). Uses run.sh's helpers
# (new_stub, eq, contains, lacks, check, fail) and its variables (T, ROOT, INFRA, STUB_BIN, STUB_DIR, CURRENT).
GUARD=apply-data-write-guard.sh
ACCT=123456789012
unrelated='{"Sid":"KeepMe","Effect":"Allow","Principal":{"Service":"cloudfront.amazonaws.com"},"Action":"s3:GetObject","Resource":"arn:aws:s3:::harrisonfamily-frontend/*"}'
stale='{"Sid":"HfyDataWriteGuardRecords","Effect":"Deny","Principal":"*","Action":"s3:PutObject","Resource":"arn:aws:s3:::harrisonfamily-frontend/old/*"}'
guard_run() { # ARGS... : run the guard against the stub (new_stub must have run)
  set +e; OUT=$(PATH="$STUB_BIN:$PATH" HFY_S3_BACKUP_DIR="$STUB_DIR/s3-backups" "$INFRA/$GUARD" "$@" 2>&1); RC=$?; set -e
}
policy_of() { jq -c "$2" "$1"; }
writes() { if [ -f "$STUB_DIR/policy-writes.log" ]; then wc -l < "$STUB_DIR/policy-writes.log" | tr -d ' '; else echo 0; fi; }

CURRENT="guard: refusals"
new_stub
guard_run
eq "no mode flag is refused" "$RC" 2
guard_run --confirm-g-cutover --policy-file "$T/none.json"
eq "a policy file can never drive a real put" "$RC" 2
guard_run --bogus
eq "unknown argument" "$RC" 2
check "no AWS call was made by a refusal" test ! -f "$STUB_DIR/calls.log"

CURRENT="guard: --dry-run prints the merged policy and preserves the existing statements"
new_stub
printf '{"Version":"2012-10-17","Statement":[%s,%s]}' "$unrelated" "$stale" > "$T/current.json"
guard_run --dry-run --policy-file "$T/current.json"
eq "exit code" "$RC" 0
contains "says it changes nothing" "$OUT" "(dry-run) no changes made"
contains "summary counts both guard statements and the kept one" "$OUT" "guard: 2, others kept: 1"
check "an offline dry run makes no AWS call" test ! -f "$STUB_DIR/calls.log"
echo "$OUT" | sed -n '/^{/,/^}/p' > "$T/merged.json"
eq "KeepMe is preserved untouched" "$(jq -cS '.Statement[] | select(.Sid == "KeepMe")' "$T/merged.json")" "$(echo "$unrelated" | jq -cS .)"
eq "the stale guard statement is replaced, not duplicated" "$(jq -c '[.Statement[].Sid] | sort' "$T/merged.json")" '["HfyDataWriteGuardMediaDelete","HfyDataWriteGuardRecords","KeepMe"]'
eq "records statement: Put and Delete on exactly the record patterns" \
  "$(jq -c '.Statement[] | select(.Sid == "HfyDataWriteGuardRecords") | [.Effect, .Principal, (.Action | sort), (.Resource | map(sub("^arn:aws:s3:::[^/]+/"; "")))]' "$T/merged.json")" \
  '["Deny","*",["s3:DeleteObject","s3:DeleteObjectVersion","s3:PutObject"],["person/*.json","family/*","event/*","note/*","place/*","media/*.json"]]'
eq "media statement: Delete on media/* only" \
  "$(jq -c '.Statement[] | select(.Sid == "HfyDataWriteGuardMediaDelete") | [.Effect, (.Action | sort), (.Resource | map(sub("^arn:aws:s3:::[^/]+/"; "")))]' "$T/merged.json")" \
  '["Deny",["s3:DeleteObject","s3:DeleteObjectVersion"],["media/*"]]'
eq "records exceptions: the two renderers and break-glass, never hfy-api" \
  "$(jq -c '.Statement[] | select(.Sid == "HfyDataWriteGuardRecords") | .Condition.ArnNotLike["aws:PrincipalArn"] | map(sub("^arn:aws:iam::[0-9]+:role/"; ""))' "$T/merged.json")" \
  '["hfy-sync-render-role","hfy-graph-render-role","hfy-data-breakglass"]'
eq "media Delete exceptions add hfy-api (binaries only)" \
  "$(jq -c '.Statement[] | select(.Sid == "HfyDataWriteGuardMediaDelete") | .Condition.ArnNotLike["aws:PrincipalArn"] | map(sub("^arn:aws:iam::[0-9]+:role/"; ""))' "$T/merged.json")" \
  '["hfy-sync-render-role","hfy-graph-render-role","hfy-data-breakglass","hfy-api-role"]'
guard_run --dry-run --policy-file /dev/null
contains "an empty policy file means no policy, and the dry run says one is added" "$OUT" "(dry-run) the policy would change"

CURRENT="guard: the deny patterns are pinned to ci.manifest.yaml deploy.exclude"
if python3 -c 'import yaml' 2>/dev/null; then
  guard_run --dry-run --policy-file /dev/null
  echo "$OUT" | sed -n '/^{/,/^}/p' > "$T/fresh.json"
  PIN=$(ROOT="$ROOT" GUARD_POLICY="$T/fresh.json" python3 - <<'PY'
import fnmatch, json, os, pathlib, re, yaml
root = pathlib.Path(os.environ["ROOT"])
manifest = yaml.safe_load((root / "ci.manifest.yaml").read_text())
exclude = next(t["exclude"] for t in manifest["deploy"]["targets"] if t["kind"] == "s3_static")
policy = json.load(open(os.environ["GUARD_POLICY"]))
strip = lambda r: re.sub(r"^arn:aws:s3:::[^/]+/", "", r)
by = {s["Sid"]: [strip(r) for r in s["Resource"]] for s in policy["Statement"]}
put = by["HfyDataWriteGuardRecords"]; delete_media = by["HfyDataWriteGuardMediaDelete"]
# Not data: site files the kit excludes from the sync (member uploads have their own deny in github-roles.yaml).
NOT_DATA = {"uploads/*", "README.md"}
data = [e for e in exclude if e not in NOT_DATA]
print("every data exclude is denied for Put:", all(e in put or (e == "media/*" and "media/*.json" in put and "media/*" in delete_media) for e in data))
print("every Put deny is an exclude (media/*.json via media/*):", all(p in exclude or (p == "media/*.json" and "media/*" in exclude) for p in put))
print("only known non-data excludes are left out:", sorted(e for e in exclude if e not in put and e != "media/*") == sorted(NOT_DATA))
print("the exclude list still has the data prefixes:", len(data) >= 5)
src = [str(p.relative_to(root / "11ty")) for p in (root / "11ty").rglob("*") if p.is_file()]
hit = [f for f in src if any(fnmatch.fnmatchcase(f, g) for g in put)]
print("11ty/ output holds no key the deny covers:", hit == [])
js = (root / "scripts/cloudfront/append-index.js").read_text()
files = re.search(r"var PUBLIC_PERSON_FILES = \[(.*?)\];", js).group(1)
keys = [k.strip().strip("'\"").lstrip("/") for k in files.split(",") if k.strip()]
print("PUBLIC_PERSON_FILES found:", len(keys) > 0)
print("PUBLIC_PERSON_FILES outside the deny:", all(not fnmatch.fnmatchcase(k, g) for k in keys for g in put + delete_media))
PY
  )
  contains "every data exclude is denied" "$PIN" "every data exclude is denied for Put: True"
  contains "every Put deny is an exclude" "$PIN" "every Put deny is an exclude (media/*.json via media/*): True"
  contains "the only excludes left out are uploads/* and README.md" "$PIN" "only known non-data excludes are left out: True"
  contains "the exclude list still has the data prefixes" "$PIN" "the exclude list still has the data prefixes: True"
  contains "the deploy source holds no denied key" "$PIN" "11ty/ output holds no key the deny covers: True"
  contains "PUBLIC_PERSON_FILES is read" "$PIN" "PUBLIC_PERSON_FILES found: True"
  contains "person/index.html (every PUBLIC_PERSON_FILES key) is outside the deny" "$PIN" "PUBLIC_PERSON_FILES outside the deny: True"
  BG=$(python3 - "$ROOT/infrastructure/cloudformation/app-stack.yaml" <<'PY'
import re, sys
t = open(sys.argv[1]).read()
b = t[t.index("BreakGlassRole:"):]
print(" ".join(sorted(set(re.findall(r"\$\{MediaBucket\}/(\w+)/\*", b)))))
PY
  )
  eq "the break-glass role grants the same prefixes the deny covers (app-stack.yaml)" "$BG" "event family media note person place"
else fail "python3 with PyYAML is required for the guard pin checks"; fi

CURRENT="guard: --simulate (the allow/deny matrix through iam simulate-custom-policy)"
new_stub
guard_run --simulate --policy-file /dev/null
eq "exit code" "$RC" 0
contains "the renderer role can Put person/<id>.json" "$OUT" "ok    allowed   hfy-sync-render-role"
contains "the matrix passed" "$OUT" "simulation passed"
lacks "no FAIL line" "$OUT" "FAIL"
contains "a role outside the exceptions is denied on person/<id>.json (AccessDenied)" "$OUT" "ok    explicitDeny hfy-not-allowed-role"
contains "the deploy role can Put person/index.html" "$OUT" "ok    allowed   harrisonfamily-github-deploy-role"
contains "the deploy role cannot Put person/x.json" "$OUT" "ok    explicitDeny harrisonfamily-github-deploy-role"
contains "hfy-api cannot Put media/x.json" "$OUT" "explicitDeny hfy-api-role"
eq "all 19 probes passed" "$(echo "$OUT" | grep -c '^ok ')" 19
check "simulate-custom-policy was the API used" grep -q 'iam simulate-custom-policy' "$STUB_DIR/calls.log"
check "the simulation changed nothing" test ! -f "$STUB_DIR/policy-writes.log"
# The matrix has teeth: against a policy without the guard, the deny probes must fail. (Simulating a "remove" run models that policy.)
new_stub
printf '{"Version":"2012-10-17","Statement":[%s]}' "$unrelated" > "$T/current.json"
set +e; OUT=$(PATH="$STUB_BIN:$PATH" "$INFRA/$GUARD" --simulate --remove --policy-file "$T/current.json" 2>&1); RC=$?; set -e
eq "--remove --simulate: a stranger may Put person/x.json again" "$RC" 0

CURRENT="guard: real apply, rerun, remove"
new_stub
printf '{"Version":"2012-10-17","Statement":[%s]}' "$unrelated" > "$STUB_DIR/bucket-policy.json"
guard_run --confirm-g-cutover
eq "apply exit code" "$RC" 0
contains "apply says so" "$OUT" "bucket policy applied"
eq "one put" "$(writes)" 1
eq "the live policy holds the kept statement and both guards" "$(policy_of "$STUB_DIR/bucket-policy.json" '[.Statement[].Sid] | sort')" '["HfyDataWriteGuardMediaDelete","HfyDataWriteGuardRecords","KeepMe"]'
eq "the account id came from sts" "$(grep -c "iam::$ACCT:role/hfy-sync-render-role" "$STUB_DIR/bucket-policy.json")" 2
check "the pre-change policy was saved" test -s "$(find "$STUB_DIR/s3-backups" -name 'harrisonfamily-frontend-*-before.json' | head -1)"
guard_run --confirm-g-cutover
contains "a rerun is a no-op" "$OUT" "already has the intended policy: no change"
eq "...and makes no second put" "$(writes)" 1
guard_run --remove --dry-run
eq "remove dry run exit code" "$RC" 0
contains "remove dry run keeps KeepMe" "$OUT" '"Sid": "KeepMe"'
lacks "remove dry run drops the guard" "$OUT" "HfyDataWriteGuardRecords"
eq "remove dry run changed nothing" "$(writes)" 1
guard_run --remove --confirm-g-cutover
eq "remove exit code" "$RC" 0
eq "the guard is gone and KeepMe remains" "$(policy_of "$STUB_DIR/bucket-policy.json" '[.Statement[].Sid]')" '["KeepMe"]'
new_stub; guard_run --confirm-g-cutover; guard_run --remove --confirm-g-cutover
contains "a policy that held only the guard is deleted, not left empty" "$OUT" "bucket policy deleted"
check "the policy is gone" test ! -f "$STUB_DIR/bucket-policy.json"
new_stub; guard_run --confirm-g-cutover --bucket test-bucket-not-prod
eq "no existing policy (NoSuchBucketPolicy): apply works" "$RC" 0
eq "...on the named bucket" "$(grep -c 'arn:aws:s3:::test-bucket-not-prod/person/\*.json' "$STUB_DIR/bucket-policy.json")" 1

CURRENT="runbook: sync-gramps-with-the-website.md (cutover order and rollback)"
DOC="$ROOT/docs/how-to/sync-gramps-with-the-website.md"
check "the replacement doc exists" test -s "$DOC"
check "the old refresh doc is gone" test ! -e "$ROOT/docs/how-to/refresh-the-family-data.md"
cat > "$T/runbook-check.py" <<'PY'
import os, re, sys
t = open(sys.argv[1]).read(); script = open(sys.argv[2]).read()
at = t.find
order = ["## Cut over to the cloud store", "### Deny first", "### Then live", "### Then verify", "## Roll back"]
print("cutover headings in order:", all(at(a) >= 0 for a in order) and [at(a) for a in order] == sorted(at(a) for a in order))
rb = t[at("## Roll back"):]
nxt = rb.find("\n## ", 5)
rb = rb if nxt < 0 else rb[:nxt]
steps = [rb.find(x) for x in ["RENDER_MODE=off", "desktop pull", "--no-delete", "moderation"]]
print("rollback names the primary, then the last-resort steps in order:", all(s >= 0 for s in steps) and steps == sorted(steps))
print("primary rollback needs no republish:", "freezes" in rb and "no republish" in rb.lower())
print("legacy republish is last resort only:", "last resort" in rb.lower())
print("break-glass run uses --no-delete and --legacy-break-glass:", "--legacy-break-glass" in rb and "--no-delete" in rb)
flags = re.findall(r"apply-data-write-guard\.sh[^\n`]*", t)
used = {f for line in flags for f in re.findall(r"--[a-z0-9-]+", line)}
print("script flags named exist:", len(used) > 0 and all(f in script for f in used))
print("approval gate named:", "G-cutover" in t)
base = os.path.dirname(sys.argv[1]); broken = []
for m in re.finditer(r"\]\(([^)#\s]+)(#[^)]*)?\)", t):
    p = m.group(1)
    if p.startswith(("http", "mailto")): continue
    if not os.path.exists(os.path.normpath(os.path.join(base, p))): broken.append(p)
print("no broken relative links:", broken == [], broken)
PY
RB=$(python3 "$T/runbook-check.py" "$DOC" "$INFRA/$GUARD")
for k in "cutover headings in order: True" "rollback names the primary, then the last-resort steps in order: True" "primary rollback needs no republish: True" \
  "legacy republish is last resort only: True" "break-glass run uses --no-delete and --legacy-break-glass: True" "script flags named exist: True" \
  "approval gate named: True" "no broken relative links: True"; do contains "runbook: $k" "$RB" "$k"; done
# The rollback is dry-run checked: the policy-level step is exercised above (--remove --dry-run) and the runbook names that command.
contains "the runbook names the rollback dry run" "$(cat "$DOC")" "apply-data-write-guard.sh --remove --dry-run"
