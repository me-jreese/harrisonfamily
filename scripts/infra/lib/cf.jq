# Shared CloudFront DistributionConfig helpers for scripts/infra/add-*-behavior.sh (HFY-R58).
# Pure functions over a DistributionConfig object; no AWS access. Load with: jq -L scripts/infra/lib 'include "cf"; ...'
#
# Idempotency contract: every upsert merges into the existing item IN PLACE (same array position) and keeps every field
# it does not manage (ConnectionAttempts, ConnectionTimeout, OriginShield, TrustedSigners, TrustedKeyGroups, GrpcConfig,
# and whatever CloudFront adds next), so re-applying an already-applied change yields a config whose `norm` is identical
# to the input's, and the caller skips update-distribution.

def drop_nulls: with_entries(select(.value != null));

# Keys CloudFront treats the same whether they are "" or absent.
def _empty_equiv_keys: ["OriginRequestPolicyId", "ResponseHeadersPolicyId", "RealtimeLogConfigArn", "FieldLevelEncryptionId", "OriginAccessControlId", "OriginPath"];

# Canonical form used ONLY to decide whether an update is needed (the update itself sends the merged config as is).
# CloudFront echoes string sets (methods, TLS protocols, aliases) in its own order and omits empty Items lists.
def norm:
  walk(
    if type == "object" then
      (if (.Quantity? == 0) and ((.Items? // []) == []) then del(.Items) else . end)
      | (if ((.Items? | type) == "array") and (.Items | all(type == "string")) then .Items |= sort else . end)
      | with_entries(select(((.key as $k | _empty_equiv_keys | index($k)) != null and .value == "") | not))
    else . end);

# CloudFront path-pattern semantics: '*' is any run of characters, '?' exactly one, case-sensitive, leading '/' optional.
def glob_re: ltrimstr("/") | gsub("(?<c>[.+^$(){}|\\[\\]\\\\])"; "\\\(.c)") | gsub("\\*"; ".*") | gsub("\\?"; ".") | "^" + . + "$";
def pattern_matches($path): glob_re as $re | ($path | ltrimstr("/")) | test($re);

def _index_where(f): [to_entries[] | select(.value | f) | .key] | first;

# Merge the managed fields of $o into the origin with the same Id in place; append when absent.
# CustomOriginConfig is merged one level deeper so fields CloudFront adds to it survive.
def upsert_origin($o):
  (.Origins.Items // []) as $items
  | ($items | _index_where(.Id == $o.Id)) as $i
  | .Origins.Items = (
      if $i == null then $items + [$o | drop_nulls]
      else $items | .[$i] = (
        (.[$i] + ($o | del(.CustomOriginConfig))
          + (if $o.CustomOriginConfig != null then {CustomOriginConfig: ((.[$i].CustomOriginConfig // {}) + $o.CustomOriginConfig)} else {} end))
        | if $o.CustomOriginConfig != null then del(.S3OriginConfig) else . end
        | drop_nulls)
      end)
  | .Origins.Quantity = (.Origins.Items | length);

# Merge $b into the behavior with the same PathPattern in place (shallow: managed keys replace wholesale, unmanaged keys
# are kept, a managed key set to null is removed); append when absent ($b must then be a complete behavior).
def upsert_behavior($b):
  (.CacheBehaviors.Items // []) as $items
  | ($items | _index_where(.PathPattern == $b.PathPattern)) as $i
  | .CacheBehaviors.Items = (if $i == null then $items + [$b | drop_nulls] else $items | .[$i] = ((.[$i] + $b) | drop_nulls) end)
  | .CacheBehaviors.Quantity = (.CacheBehaviors.Items | length);

# HFY-R58 (1): resolve the behavior that must keep serving $pin.path (the legacy POST /api/check-allowed) after a broader
# pattern is retargeted. Evaluated on the BEFORE config. $pin = {pattern, path, avoidOrigin, fallbackOrigin, template}:
#  - an existing $pin.pattern behavior is kept exactly as it is;
#  - otherwise the first behavior that serves $pin.path today is cloned under $pin.pattern (same origin, policies and
#    associations), so the path keeps its CURRENT origin;
#  - only when nothing but $pin.avoidOrigin or the default behavior serves it does $pin.fallbackOrigin (an explicit
#    --legacy-origin) apply; with no fallback this errors and the caller refuses to touch the distribution.
def resolve_pin($pin):
  (.CacheBehaviors.Items // []) as $items
  | ([$items[] | select(.PathPattern == $pin.pattern)] | first) as $existing
  | if $existing != null then
      if $existing.TargetOriginId == $pin.avoidOrigin then
        error("refusing: the existing \($pin.pattern) behavior targets \($pin.avoidOrigin); it must keep the legacy origin (repair it by hand or with --legacy-origin after deleting it)")
      else $existing end
    else
      ($items | _index_where(.PathPattern != $pin.pattern and (.PathPattern | pattern_matches($pin.path)))) as $m
      | if $m != null and $items[$m].TargetOriginId != $pin.avoidOrigin then $items[$m] + {PathPattern: $pin.pattern}
        elif $pin.fallbackOrigin != null then
          if any((.Origins.Items // [])[]; .Id == $pin.fallbackOrigin) then $pin.template + {PathPattern: $pin.pattern, TargetOriginId: $pin.fallbackOrigin}
          else error("refusing: --legacy-origin \($pin.fallbackOrigin) is not an origin of this distribution") end
        elif $m != null then
          error("refusing: \($pin.path) is already routed to \($pin.avoidOrigin) by \($items[$m].PathPattern) and no \($pin.pattern) behavior exists; pass --legacy-origin <origin id> to pin it back")
        else
          error("refusing: no cache behavior serves \($pin.path) today (only the default behavior), so its legacy origin is unknown; pass --legacy-origin <origin id>")
        end
    end;

# Put $pinBeh immediately before the first other behavior matching $path, unless it already precedes it.
def place_pin($pinBeh; $path):
  (.CacheBehaviors.Items // []) as $items
  | ($items | _index_where(.PathPattern == $pinBeh.PathPattern)) as $cur
  | ($items | _index_where(.PathPattern != $pinBeh.PathPattern and (.PathPattern | pattern_matches($path)))) as $anchor
  | if $cur != null and ($anchor == null or $cur < $anchor) then .
    else
      [$items[] | select(.PathPattern != $pinBeh.PathPattern)] as $others
      | ($others | _index_where(.PathPattern | pattern_matches($path))) as $a
      | .CacheBehaviors.Items = (if $a == null then $others + [$pinBeh] else $others[:$a] + [$pinBeh] + $others[$a:] end)
    end
  | .CacheBehaviors.Quantity = (.CacheBehaviors.Items | length);

def redact_origin_verify: (.. | objects | select(.HeaderName? == "X-Origin-Verify") | .HeaderValue) = "<redacted>";
