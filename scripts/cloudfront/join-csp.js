// HFYJoinCsp: CloudFront Function (viewer-response, runtime cloudfront-js-1.0 = ES5.1), attached to the DEFAULT cache behavior
// next to HFYAppendIndex (HFY-TSK-149). Declared in infrastructure/cloudformation/app-stack.yaml (JoinCspFunction, AutoPublish:
// the template carries this exact source; scripts/cloudfront/test/site-csp.test.mjs pins them together).
//
// The response headers policy (SiteCspReportOnlyPolicy, then SiteCspPolicy) gives every HTML page the site CSP, which allows no
// third party. Turnstile on /join/ needs challenges.cloudflare.com (script, frame, connect), and a response headers policy cannot
// vary by path without a new cache behavior, which this change does not add. So for /join and /join/* only, this function swaps the
// policy's header for the /join/ variant, in whichever mode the policy is in (enforcing header or report-only header). When the
// response carries neither header (policy detached) it does nothing, so detaching the policy removes the CSP everywhere, /join/
// included. ASSUMPTION: CloudFront runs this function after the policy has added its header. Unproven here, so
// scripts/infra/add-csp-headers.sh --mode enforce is gated on a live /join/ probe. The string below is scripts/cloudfront/site-csp.json "join".

var JOIN_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com; frame-ancestors 'none'";
var CSP_HEADERS = ['content-security-policy', 'content-security-policy-report-only'];

function isJoinPath(uri) {
  var path = String(uri || '').split('?')[0].toLowerCase();
  return path === '/join' || path.indexOf('/join/') === 0;
}

function handler(event) {
  var response = event.response;
  var i;
  if (!isJoinPath(event.request && event.request.uri) || !response || !response.headers) { return response; }
  for (i = 0; i < CSP_HEADERS.length; i++) {
    if (response.headers[CSP_HEADERS[i]]) { response.headers[CSP_HEADERS[i]] = { value: JOIN_CSP }; }
  }
  return response;
}
