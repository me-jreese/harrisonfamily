// HFYAppendIndex: CloudFront Function (viewer-request, runtime cloudfront-js-1.0 = ES5.1), attached to the DEFAULT cache
// behavior of distribution E2JCDK3QLQNNYB only. Publish with scripts/infra/publish-append-index.sh.
//
// 1. Clean URLs: a path ending in "/" gets "index.html" appended, an extensionless path gets "/index.html" (S3 has no
//    directory index). This part is unchanged.
// 2. Default-deny for private data (data gate hardening). The private prefixes (/person/*.json, /family/*, /event/*,
//    /note/*, /place/*, /media/*, /uploads/*) have their own behaviors with the hfy-edge-gate Lambda@Edge, but CloudFront path
//    patterns are case-sensitive and /person/*.json is suffix-anchored, so /Person/index.json, /FAMILY/F1.json,
//    /person/I0001.JSON, /person/I0001.json/, /person/index.json. , ;params, %20 or backslash variants match NONE of them
//    and fall through to this default behavior, which reaches S3 with no gate. Real requests for private data always match
//    their exact gated pattern first and never get here, so any request that arrives here and names a private prefix is a
//    variant or a probe: answer 404 with Cache-Control "private, no-store" (so Cloudflare never stores it) and never touch S3.
//    - first path segment (case-folded, percent-decoded, dot segments, ";params", trailing dots and spaces and backslashes
//      normalized) is family, event, note, place, media or uploads: 404.
//    - first segment is person: 404 unless the request is exactly the public person page shell (PUBLIC_PERSON_FILES, the
//      files of 11ty/person/; "/person/" and "/person" rewrite to it). Any ".json" under /person/ is a 404 regardless.
// The checks run on the rewritten URI, so "/media", "/media/" and "/Media/x" are all caught the same way. Only ES5.1 here
// (plus the String endsWith/includes the original already used): no let/const/arrow functions/template literals.

var DENY_FIRST_SEGMENTS = ['family', 'event', 'note', 'place', 'media', 'uploads'];
var PUBLIC_PERSON_FILES = ['/person/index.html'];

function decodeAll(s) {
  // S3 decodes the key itself, so "%2e", "%2F" and "%252e" must be seen as "." "/" and "." here. Tolerant: a malformed
  // escape stays as it is instead of throwing, and 4 rounds are enough for any realistic multiple encoding.
  var prev, i;
  for (i = 0; i < 4; i++) {
    prev = s;
    s = s.replace(/%([0-9a-fA-F]{2})/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); });
    if (s === prev) { break; }
  }
  return s;
}

function normalizedSegments(uri) {
  var parts = decodeAll(uri).toLowerCase().replace(/\\/g, '/').split('/');
  var out = [];
  var i, p;
  for (i = 0; i < parts.length; i++) {
    p = parts[i].replace(/;.*$/, '').replace(/^\s+|\s+$/g, '');
    if (p === '' || p === '.') { continue; }
    if (p === '..') { out.pop(); continue; }
    p = p.replace(/[.\s]+$/, '');
    if (p !== '') { out.push(p); }
  }
  return out;
}

function isPrivateVariant(uri) {
  var segments = normalizedSegments(uri);
  var first = segments[0];
  if (first === undefined) { return false; }
  if (DENY_FIRST_SEGMENTS.indexOf(first) !== -1) { return true; }
  if (first === 'person') {
    if (decodeAll(uri).toLowerCase().indexOf('.json') !== -1) { return true; }
    return PUBLIC_PERSON_FILES.indexOf(uri) === -1;
  }
  return false;
}

function notFound() {
  return {
    statusCode: 404,
    statusDescription: 'Not Found',
    headers: { 'cache-control': { value: 'private, no-store' } }
  };
}

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri.endsWith('/')) {
    request.uri += 'index.html';
  } else if (!uri.includes('.')) {
    request.uri += '/index.html';
  }

  if (isPrivateVariant(request.uri)) {
    return notFound();
  }

  return request;
}
