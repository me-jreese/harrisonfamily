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

def redact_origin_verify: (.. | objects | select(.HeaderName? == "X-Origin-Verify") | .HeaderValue) = "<redacted>";

# HFY-TSK-080: keep an existing $pat behavior (merged fields and all) ahead of the first OTHER behavior that would also match
# $path, otherwise CloudFront's first-match rule lets that broader behavior shadow it. A behavior that is already ahead, or
# absent, is left alone; nothing else is reordered.
def place_before_shadow($pat; $path):
  (.CacheBehaviors.Items // []) as $items
  | ($items | _index_where(.PathPattern == $pat)) as $cur
  | ($items | _index_where(.PathPattern != $pat and (.PathPattern | pattern_matches($path)))) as $anchor
  | if $cur == null or $anchor == null or $cur < $anchor then .
    else
      [$items[] | select(.PathPattern != $pat)] as $others
      | ($others | _index_where(.PathPattern | pattern_matches($path))) as $a
      | .CacheBehaviors.Items = ($others[:$a] + [$items[$cur]] + $others[$a:])
    end
  | .CacheBehaviors.Quantity = (.CacheBehaviors.Items | length);

# HFY-TSK-080 rollback: drop the behaviors in $pats that carry a Lambda@Edge association of function $fn. A behavior with a
# listed pattern but no such association is not ours and is kept.
def remove_gate_behaviors($pats; $fn):
  .CacheBehaviors.Items = [ (.CacheBehaviors.Items // [])[]
      | select(((.PathPattern as $p | $pats | index($p)) != null
                and any((.LambdaFunctionAssociations.Items // [])[]; (.LambdaFunctionARN | test(":function:" + $fn + ":[0-9]+$")))) | not) ]
  | .CacheBehaviors.Quantity = (.CacheBehaviors.Items | length);

# HFY-R65: does the input ResponseHeadersPolicyConfig force Cache-Control to exactly $value on every response? True only when it
# has a single Cache-Control custom header with that value and Override:true, and does not also list Cache-Control in
# RemoveHeadersConfig. Header names compare case-insensitively, as HTTP does.
def rhp_forces_cache_control($value):
  ([(.CustomHeadersConfig.Items // [])[] | select((.Header // "" | ascii_downcase) == "cache-control")]) as $cc
  | ($cc | length) == 1 and $cc[0].Value == $value and $cc[0].Override == true
    and ([(.RemoveHeadersConfig.Items // [])[] | (.Header // "" | ascii_downcase)] | index("cache-control")) == null;

# Does the behavior $pat carry a Lambda@Edge association of function $fn (any published version)? Input: a DistributionConfig.
def behavior_gated($pat; $fn):
  any((.CacheBehaviors.Items // [])[]; .PathPattern == $pat
      and any((.LambdaFunctionAssociations.Items // [])[]; .LambdaFunctionARN | test(":function:" + $fn + ":[0-9]+$")));

# HFY members-only /uploads/*: the gate's rollback. Put the behavior $pat back to its previous ungated state IN PLACE (never
# deleted): no Lambda@Edge association, cache policy $cp and response headers policy $rhp. Only a behavior that carries the
# $fn association is touched; origin and every other field are kept.
def ungate_behavior($pat; $fn; $cp; $rhp):
  if behavior_gated($pat; $fn) | not then .
  else .CacheBehaviors.Items |= map(
      if .PathPattern == $pat
      then . + {LambdaFunctionAssociations: {Quantity: 0}, CachePolicyId: $cp, ResponseHeadersPolicyId: $rhp}
      else . end)
  end;

# HFY members-only /uploads/*: is the input ResponseHeadersPolicyConfig whole? It must force Cache-Control: $value
# (rhp_forces_cache_control) AND keep the inert-upload security headers of the app stack's UploadsResponseHeadersPolicy:
# X-Content-Type-Options: nosniff and Content-Security-Policy: $csp, both with Override.
def rhp_uploads_private($value; $csp):
  rhp_forces_cache_control($value)
  and ((.SecurityHeadersConfig.ContentTypeOptions.Override // false) == true)
  and ((.SecurityHeadersConfig.ContentSecurityPolicy.Override // false) == true)
  and ((.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy // "") == $csp);
