# Test-only: emulate how CloudFront echoes a DistributionConfig back from get-distribution-config after update-distribution.
# It fills in the defaults the scripts never send, reorders string sets and drops empty Items lists, which is exactly the
# drift that used to make the behavior scripts redeploy on every run (behavior-scripts-not-idempotent).
def echo_set: if (.Items? | type) == "array" then .Items |= reverse else . end;
def echo_empty: walk(if type == "object" and .Quantity? == 0 and (.Items? // []) == [] then del(.Items) else . end);
{ETag: $etag, DistributionConfig: (
  (.DistributionConfig // .)
  | .Origins.Items |= map(
      {ConnectionAttempts: 3, ConnectionTimeout: 10, OriginShield: {Enabled: false}, OriginAccessControlId: "", CustomHeaders: {Quantity: 0}} + .
      | if .CustomOriginConfig then .CustomOriginConfig |= ({IpAddressType: "ipv4"} + .) | .CustomOriginConfig.OriginSslProtocols |= echo_set else . end)
  | .CacheBehaviors.Items |= map(
      {TrustedSigners: {Enabled: false, Quantity: 0}, TrustedKeyGroups: {Enabled: false, Quantity: 0}, GrpcConfig: {Enabled: false}} + .
      | .AllowedMethods |= (echo_set | .CachedMethods |= echo_set))
  | echo_empty)}
