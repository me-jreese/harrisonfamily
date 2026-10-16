#!/usr/bin/env bash
# Smoke invoke of the deployed hfy-graph-render (HFY-TSK-274, review DL-34): the function crops a synthetic face with the packaged
# linux/arm64 sharp and answers its facts. It calls no AWS service and reads no family data, so it is safe at any time.
# Fails (exit 1) unless the answer is {"status":"smoke","ok":true,"format":"webp","width":160,"height":160}.
# Usage: bash scripts/ci/smoke-graph-render.sh [--function hfy-graph-render] [--region us-west-2] [--profile <aws profile>]
set -euo pipefail
FN=hfy-graph-render; REGION=us-west-2; PROFILE=()
while [ $# -gt 0 ]; do
  case "$1" in
    --function) FN="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --profile) PROFILE=(--profile "$2"); shift 2 ;;
    *) echo "usage: $0 [--function NAME] [--region REGION] [--profile PROFILE]" >&2; exit 2 ;;
  esac
done
OUT="$(mktemp)"; trap 'rm -f "$OUT"' EXIT
aws lambda invoke "${PROFILE[@]}" --region "$REGION" --function-name "$FN" --cli-binary-format raw-in-base64-out \
  --payload '{"smoke":true}' "$OUT" --query 'FunctionError' --output text > "$OUT.err" || { echo "smoke-graph-render: the invoke failed" >&2; exit 1; }
trap 'rm -f "$OUT" "$OUT.err"' EXIT
[ "$(cat "$OUT.err")" = "None" ] || { echo "smoke-graph-render: the function answered an error" >&2; exit 1; }
python3 - "$OUT" <<'PY'
import json, sys
body = json.load(open(sys.argv[1]))
ok = body.get("status") == "smoke" and body.get("ok") is True and (body.get("format"), body.get("width"), body.get("height")) == ("webp", 160, 160)
print("smoke-graph-render:", "ok" if ok else "FAILED", json.dumps({k: body.get(k) for k in ("status", "ok", "format", "width", "height", "bytes")}))
sys.exit(0 if ok else 1)
PY
