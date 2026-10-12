// Tests for scripts/cloudfront/append-index.js (HFYAppendIndex): the original index.html appending, plus the default-deny for
// case/suffix/encoding variants of the private data prefixes. Run: node --test scripts/cloudfront/test/*.test.mjs
// The function source is loaded exactly as CloudFront gets it (a sandboxed global scope, no module wrapper).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const SOURCE = readFileSync(join(ROOT, "scripts/cloudfront/append-index.js"), "utf8");
const CASES = JSON.parse(readFileSync(join(HERE, "append-index.cases.json"), "utf8"));

const ctx = vm.createContext({});
vm.runInContext(SOURCE, ctx, { filename: "append-index.js" });

function run(uri, extra = {}) {
  const request = { method: "GET", uri, headers: { host: { value: "harrisonfamily.us" } }, cookies: {}, querystring: {}, ...extra };
  return vm.runInContext("handler", ctx)({ version: "1.0", context: { eventType: "viewer-request" }, viewer: { ip: "203.0.113.9" }, request });
}
const isDeny = (r) => r.statusCode === 404;
const toJson = (v) => JSON.parse(JSON.stringify(v)); // out of the vm realm, so deepStrictEqual compares prototypes fairly

test("rewrite: the original index.html appending is unchanged", () => {
  for (const { uri, expect } of CASES.rewrite) {
    const r = run(uri);
    assert.equal(isDeny(r), false, `${uri} must not be denied`);
    assert.equal(r.uri, expect, `${uri} -> ${expect}`);
  }
});

test("rewrite: only the uri changes; method, headers, cookies and querystring pass through", () => {
  const extra = { method: "HEAD", headers: { host: { value: "harrisonfamily.us" }, cookie: { value: "io_id=x" } }, cookies: { io_id: { value: "x" } }, querystring: { id: { value: "I0001" } } };
  const r = run("/person/", extra);
  assert.deepEqual(toJson(r), { ...extra, uri: "/person/index.html" });
  assert.equal(toJson(run("/about/", extra)).querystring.id.value, "I0001");
});

test("rewrite: the exact original rule is kept ('/' appends index.html, extensionless appends /index.html, dotted is untouched)", () => {
  assert.equal(run("/x/").uri, "/x/index.html");
  assert.equal(run("/x").uri, "/x/index.html");
  assert.equal(run("/x.y").uri, "/x.y");
  assert.equal(run("/a.b/c").uri, "/a.b/c");
});

test("deny: every private variant gets 404 with Cache-Control: private, no-store and is never forwarded to S3", () => {
  for (const uri of CASES.deny) {
    const r = run(uri);
    assert.equal(r.statusCode, 404, `${JSON.stringify(uri)} must be 404`);
    assert.equal(r.statusDescription, "Not Found");
    assert.deepEqual(toJson(r.headers), { "cache-control": { value: "private, no-store" } }, uri);
    assert.equal(r.uri, undefined, `${uri}: a response object, not a request`);
  }
});

test("deny: the fixture covers the reported bypass variants", () => {
  const must = ["/Person/index.json", "/PERSON/index.json", "/person/I0001.JSON", "/person/I0001.json/", "/person/index.json. ", "/person/index.json%20",
    "/person/I0001.json;a=b", "/person\\I0001.json", "/Family/F0001.json", "/Media/a/b.jpg", "/Uploads/posts/01J0000000000000000000000/photo.jpg"];
  for (const u of must) assert.ok(CASES.deny.includes(u), `${u} is in append-index.cases.json`);
});

test("deny: the legitimate public person page shell is the only thing under /person/ that passes", () => {
  assert.equal(run("/person/").uri, "/person/index.html");
  assert.equal(run("/person").uri, "/person/index.html");
  assert.equal(run("/person/index.html").uri, "/person/index.html");
  for (const u of ["/Person/", "/person/index.json", "/person/index.html/", "/person/index.html.", "/person/INDEX.HTML", "/person/other.html", "/person/x.css", "/person/x.js"]) {
    assert.ok(isDeny(run(u)), `${u} is denied`);
  }
});

test("deny: .json anywhere under /person/ is denied however it is spelled", () => {
  for (const u of ["/person/a.json", "/person/a/b/c.json", "/person/a.JSON", "/person/a.JsOn", "/person/a%2Ejson", "/person/a%252ejson", "/person/%2e%6a%73%6f%6e", "/Person/sub/dir/x.Json/", "/PERSON/x.json;v=1"]) {
    assert.ok(isDeny(run(u)), `${u} is denied`);
  }
});

test("deny: every case spelling of every private prefix is denied", () => {
  const spellings = (word) => {
    let out = [""];
    for (const ch of word) out = out.flatMap((p) => [p + ch.toLowerCase(), p + ch.toUpperCase()]);
    return out;
  };
  for (const prefix of ["family", "event", "note", "place", "media", "uploads"]) {
    for (const s of spellings(prefix)) {
      for (const tail of ["/", "/x.json", "/a/b/c.jpg", ""]) assert.ok(isDeny(run(`/${s}${tail}`)), `/${s}${tail}`);
    }
  }
  for (const s of spellings("person")) {
    for (const tail of ["/index.json", "/I0001.json", "/I0001.JSON", "/search-index.json"]) assert.ok(isDeny(run(`/${s}${tail}`)), `/${s}${tail}`);
    if (s !== "person") for (const tail of ["/", "", "/index.html"]) assert.ok(isDeny(run(`/${s}${tail}`)), `/${s}${tail}: only the exact-case shell is public`);
  }
});

test("deny: a private first segment is matched as a whole segment, not as a string prefix", () => {
  for (const u of ["/family-login/", "/family-login", "/media-kit/", "/placeholder/", "/notes/", "/events/", "/uploads-help/", "/personal/", "/persons/", "/family.html", "/media.json"]) {
    assert.equal(isDeny(run(u)), false, `${u} is not a private prefix`);
  }
});

test("deny: malformed escapes never throw (a throwing function is a 5xx for every visitor)", () => {
  for (const u of ["/%", "/%zz", "/%E0%A4%A", "/about%/", "/%c0%ae%c0%ae/person/x.json", "/person/%", "/media/%zz"]) {
    assert.doesNotThrow(() => run(u), u);
  }
  assert.ok(isDeny(run("/media/%zz")));
  assert.ok(isDeny(run("/person/%")));
  assert.equal(run("/about%/").uri, "/about%/index.html");
});

test("awsSamples are real cases of the table (publish-append-index.sh runs them through aws cloudfront test-function)", () => {
  const all = new Set([...CASES.rewrite.map((c) => c.uri), ...CASES.deny]);
  assert.ok(CASES.awsSamples.length >= 20);
  for (const u of CASES.awsSamples) assert.ok(all.has(u), `${u} is a case`);
  assert.ok(CASES.awsSamples.some((u) => all.has(u) && CASES.deny.includes(u)) && CASES.awsSamples.some((u) => CASES.rewrite.some((c) => c.uri === u)));
});

test("the 404 response is a CloudFront Function response object and carries nothing else", () => {
  const r = toJson(run("/Media/a.jpg"));
  assert.deepEqual(Object.keys(r).sort(), ["headers", "statusCode", "statusDescription"]);
});

test("no real site path is denied: every file and directory shipped in 11ty/ (except person/) passes", () => {
  const tracked = execFileSync("git", ["ls-files", "11ty"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  assert.ok(tracked.length > 20, "found the 11ty tree");
  const seen = new Set();
  for (const f of tracked) {
    const rel = relative("11ty", f).split("\\").join("/");
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i++) seen.add(`/${parts.slice(0, i).join("/")}${i < parts.length ? "/" : ""}`);
  }
  for (const uri of seen) {
    const r = run(uri);
    assert.equal(isDeny(r), false, `${uri} (a path of the shipped site) must not be denied`);
    if (uri.startsWith("/person/")) assert.ok(["/person/", "/person/index.html"].includes(uri), `${uri} is in 11ty/person/`);
  }
  assert.ok(seen.has("/person/index.html") && seen.has("/about/") && seen.has("/family-login/"));
});

test("PUBLIC_PERSON_FILES is exactly the set of files in 11ty/person/", () => {
  const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  const files = walk(join(ROOT, "11ty/person")).map((f) => "/person/" + relative(join(ROOT, "11ty/person"), f).split("\\").join("/")).sort();
  assert.deepEqual(toJson(ctx.PUBLIC_PERSON_FILES).slice().sort(), files);
});

test("DENY_FIRST_SEGMENTS is exactly the gated non-person prefixes of add-data-gate-behaviors.sh", () => {
  const sh = readFileSync(join(ROOT, "scripts/infra/add-data-gate-behaviors.sh"), "utf8");
  const m = sh.match(/^PATTERNS=\(([^)]*)\)/m);
  assert.ok(m, "PATTERNS=(...) found in add-data-gate-behaviors.sh");
  const patterns = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(patterns.includes("/person/*.json") && patterns.includes("/uploads/*"), `patterns: ${patterns}`);
  const prefixes = patterns.filter((p) => !p.startsWith("/person/")).map((p) => p.replace(/^\/|\/\*$/g, "")).sort();
  assert.deepEqual(toJson(ctx.DENY_FIRST_SEGMENTS).slice().sort(), prefixes);
});

test("the source is cloudfront-js-1.0 compatible (ES5.1; String endsWith/includes were already in use)", () => {
  const code = SOURCE.replace(/\/\/.*$/gm, "");
  for (const [re, what] of [[/=>/, "arrow function"], [/\blet\b/, "let"], [/\bconst\b/, "const"], [/`/, "template literal"], [/\.\.\./, "spread/rest"],
    [/\bclass\b/, "class"], [/\basync\b|\bawait\b/, "async"], [/\?\./, "optional chaining"], [/\?\?/, "nullish coalescing"], [/\*\*/, "exponent operator"],
    [/\bimport\b|\bexport\b|\brequire\(/, "modules"], [/\.(startsWith|padStart|padEnd|repeat|flat|flatMap|fromEntries|entries|values|assign|find|findIndex|trimStart|trimEnd|replaceAll|at)\(/, "post-ES5 method"],
    [/\bdecodeURIComponent\b|\bencodeURIComponent\b|\bURL\b|\bTextDecoder\b/, "host API not guaranteed in cloudfront-js-1.0"]]) {
    assert.ok(!re.test(code), `append-index.js uses ${what}`);
  }
  assert.ok(Buffer.byteLength(SOURCE) < 10 * 1024, "CloudFront Functions are limited to 10 KB");
  assert.match(SOURCE, /function handler\(event\)/);
});
