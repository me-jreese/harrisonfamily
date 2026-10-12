# shellcheck shell=bash
# shellcheck disable=SC2016 # the jq programs are single-quoted on purpose
# Shared plumbing for scripts/infra/add-*-behavior.sh. Sourced, not executed. The config transforms live in cf.jq.
#
#   cf_load DIST CFG_FILE   fetch (or copy) the config into $CF_WORK/before.json and set CF_ETAG
#   cf_apply DIST DRY WHAT  compare norm(before) with norm($CF_WORK/after.json); when they are equal print "no change" and
#                           return WITHOUT calling update-distribution (HFY-R58: true no-op). Otherwise print a redacted diff,
#                           save a timestamped pre-change backup outside the repo, and update with the fetched ETag.
#   cf_response_headers_policy NAME WANT_FILE CACHE_CONTROL DRY OFFLINE
#                           find-or-create the custom response headers policy NAME (sets CF_RHP_ID); see the function.
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

# cf_response_headers_policy NAME WANT_FILE CACHE_CONTROL DRY OFFLINE -> sets CF_RHP_ID (HFY-R65). Idempotent find-or-create of the
# custom response headers policy called NAME (names are unique per account): an existing policy that already forces
# Cache-Control: CACHE_CONTROL (cf.jq rhp_forces_cache_control) is used as is, with no write; one that does not is put back to
# WANT_FILE (a ResponseHeadersPolicyConfig) with its ETag; a missing one is created from WANT_FILE. DRY=1 only reads (a missing
# policy gets a placeholder id and "would create"); OFFLINE=1 (--config-file) makes no AWS call at all.
# shellcheck disable=SC2034 # CF_RHP_ID is the result, read by the caller
cf_response_headers_policy() {
  local name=$1 want=$2 value=$3 dry=$4 offline=$5 list id cur etag
  CF_RHP_ID=""
  if [ "$offline" = 1 ]; then
    CF_RHP_ID="<$name policy id>"; echo "(dry-run) response headers policy $name not looked up (offline); using a placeholder id"; return 0
  fi
  list=$(aws cloudfront list-response-headers-policies --type custom --output json)
  id=$(jq -r --arg n "$name" '[.ResponseHeadersPolicyList.Items[]? | .ResponseHeadersPolicy | select(.ResponseHeadersPolicyConfig.Name == $n) | .Id] | first // empty' <<<"$list")
  if [ -z "$id" ]; then
    if [ "$dry" = 1 ]; then
      CF_RHP_ID="<new $name policy id>"; echo "(dry-run) would create response headers policy $name (Cache-Control: $value, override)"; return 0
    fi
    id=$(aws cloudfront create-response-headers-policy --response-headers-policy-config "file://$want" --output json | jq -r '.ResponseHeadersPolicy.Id // empty')
    [ -n "$id" ] || { echo "create-response-headers-policy $name returned no id" >&2; return 1; }
    echo "created response headers policy $name ($id): Cache-Control: $value, override"
  else
    cur=$(jq -c --arg id "$id" '[.ResponseHeadersPolicyList.Items[]? | .ResponseHeadersPolicy | select(.Id == $id) | .ResponseHeadersPolicyConfig] | first' <<<"$list")
    if cf_jq -e --arg v "$value" 'include "cf"; rhp_forces_cache_control($v)' <<<"$cur" >/dev/null; then
      echo "response headers policy $name ($id) already forces Cache-Control: $value"
    elif [ "$dry" = 1 ]; then
      echo "(dry-run) would put response headers policy $name ($id) back to Cache-Control: $value, override"
    else
      etag=$(aws cloudfront get-response-headers-policy-config --id "$id" --output json | jq -r '.ETag // empty')
      [ -n "$etag" ] || { echo "no ETag for response headers policy $id" >&2; return 1; }
      aws cloudfront update-response-headers-policy --id "$id" --if-match "$etag" --response-headers-policy-config "file://$want" --output json >/dev/null
      echo "updated response headers policy $name ($id): Cache-Control: $value, override"
    fi
  fi
  CF_RHP_ID=$id
}
