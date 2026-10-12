# shellcheck shell=bash
# Shared plumbing for scripts/infra/add-*-behavior.sh. Sourced, not executed. The config transforms live in cf.jq.
#
#   cf_load DIST CFG_FILE   fetch (or copy) the config into $CF_WORK/before.json and set CF_ETAG
#   cf_apply DIST DRY WHAT  compare norm(before) with norm($CF_WORK/after.json); when they are equal print "no change" and
#                           return WITHOUT calling update-distribution (HFY-R58: true no-op). Otherwise print a redacted diff,
#                           save a timestamped pre-change backup outside the repo, and update with the fetched ETag.
#
# Secrets: the X-Origin-Verify value is never printed; diffs are redacted. The backup holds it and is written mode 600.

CF_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CACHING_DISABLED=4135ea2d-6df8-44a3-9df3-4b5a84be39ad
CACHING_OPTIMIZED=658327ea-f89d-4fab-a63d-7e88639e58f6
ALL_VIEWER_EXCEPT_HOST=b689b0a8-53d0-40ab-baf2-68738e2966ac
export CACHING_DISABLED CACHING_OPTIMIZED ALL_VIEWER_EXCEPT_HOST

cf_jq() { jq -L "$CF_LIB_DIR" "$@"; }

cf_check_args() { # CFG_FILE DRY: an exported config may be stale, so it can only drive a dry run
  if [ -n "$1" ] && [ "$2" != 1 ]; then
    echo "refusing to update from --config-file (an exported config may be stale); use --dry-run, or drop --config-file to read the live config" >&2
    return 2
  fi
}

cf_stack_output() { # STACK KEY -> value on stdout, fails when the output is missing
  local v
  v=$(aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text)
  if [ -z "$v" ] || [ "$v" = None ]; then echo "stack $1 has no output $2" >&2; return 1; fi
  printf '%s\n' "$v"
}

cf_origin_verify() { # SECRET_NAME DRY OFFLINE -> exports OV (never printed). OFFLINE=1 (--config-file) never calls Secrets Manager.
  OV="${ORIGIN_VERIFY:-}"
  if [ -z "$OV" ] && [ "${3:-0}" != 1 ]; then
    OV=$(aws secretsmanager get-secret-value --secret-id "$1" --query SecretString --output text 2>/dev/null || true)
  fi
  if [ -z "$OV" ]; then
    if [ "$2" = 1 ]; then OV="<origin-verify-secret>"; echo "(dry-run) origin-verify secret not read; using a placeholder"
    else echo "cannot read secret $1 (run scripts/infra/create-origin-verify.sh)" >&2; return 1; fi
  fi
  export OV
}

cf_load() { # DIST CFG_FILE
  CF_WORK=$(mktemp -d); trap 'rm -rf "$CF_WORK"' EXIT
  if [ -n "$2" ]; then cp "$2" "$CF_WORK/raw.json"; CF_ETAG=offline
  else aws cloudfront get-distribution-config --id "$1" > "$CF_WORK/raw.json"; CF_ETAG=$(jq -r .ETag "$CF_WORK/raw.json"); fi
  jq -S '.DistributionConfig // .' "$CF_WORK/raw.json" > "$CF_WORK/before.json"
}

cf_behaviors() { jq -r '[(.CacheBehaviors.Items // [])[] | "\(.PathPattern) -> \(.TargetOriginId)"] + ["default -> \(.DefaultCacheBehavior.TargetOriginId)"] | join(", ")' "$1"; }

cf_apply() { # DIST DRY WHAT
  local d=$CF_WORK backup_dir backup
  cf_jq -S 'include "cf"; norm' "$d/before.json" > "$d/before.norm"
  cf_jq -S 'include "cf"; norm' "$d/after.json" > "$d/after.norm"
  if cmp -s "$d/before.norm" "$d/after.norm"; then echo "distribution $1 already has $3: no change"; return 0; fi
  echo "cache behaviors before (in evaluation order): $(cf_behaviors "$d/before.json")"
  echo "cache behaviors after  (in evaluation order): $(cf_behaviors "$d/after.json")"
  cf_jq -S 'include "cf"; redact_origin_verify' "$d/before.norm" > "$d/before.red"
  cf_jq -S 'include "cf"; redact_origin_verify' "$d/after.norm" > "$d/after.red"
  diff -u "$d/before.red" "$d/after.red" || true
  if cmp -s "$d/before.red" "$d/after.red"; then echo "(only the X-Origin-Verify header value differs)"; fi
  if [ "$2" = 1 ]; then echo "(dry-run) no changes made"; return 0; fi
  if [ "$CF_ETAG" = offline ]; then echo "refusing to update from --config-file (an exported config may be stale); use --dry-run, or drop --config-file to read the live config" >&2; return 1; fi
  backup_dir="${HFY_CF_BACKUP_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/hfy-infra/cloudfront}"
  mkdir -p "$backup_dir"
  backup="$backup_dir/$1-$(date -u +%Y%m%dT%H%M%SZ)-before.json"
  (umask 077; cp "$d/before.json" "$backup"); chmod 600 "$backup"
  echo "saved the pre-change DistributionConfig to $backup (mode 600, holds the origin-verify header)"
  echo "roll back with: aws cloudfront update-distribution --id $1 --if-match <current ETag> --distribution-config file://$backup"
  aws cloudfront update-distribution --id "$1" --if-match "$CF_ETAG" --distribution-config "file://$d/after.json" --query 'Distribution.Status' --output text
}
