// HFY-TSK-149: the site CSP is written down once (scripts/cloudfront/site-csp.json) and the CloudFront Function that swaps in the
// /join/ variant (scripts/cloudfront/join-csp.js) must agree with it. Run: node --test scripts/cloudfront/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CSP = JSON.parse(readFileSync(join(ROOT, "scripts/cloudfront/site-csp.json"), "utf8"));
const SOURCE = readFileSync(join(ROOT, "scripts/cloudfront/join-csp.js"), "utf8");
const ctx = vm.createContext({});
vm.runInContext(SOURCE, ctx, { filename: "join-csp.js" });
const TURNSTILE = "https://challenges.cloudflare.com";

const directives = (s) => Object.fromEntries(s.split(/;\s*/).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));
const toJson = (v) => JSON.parse(JSON.stringify(v));
function run(uri, headers) {
  const event = { version: "1.0", context: { eventType: "viewer-response" }, viewer: { ip: "203.0.113.9" },
    request: { method: "GET", uri, headers: {}, cookies: {}, querystring: {} }, response: { statusCode: 200, statusDescription: "OK", headers, cookies: {} } };
  return toJson(vm.runInContext("handler", ctx)(event));
}

test("base policy: no third party anywhere, same-origin images and connections, no framing", () => {
  const d = directives(CSP.base);
  assert.deepEqual(d["default-src"], ["'self'"]);
  assert.deepEqual(d["img-src"], ["'self'", "data:", "blob:"]);
  assert.deepEqual(d["connect-src"], ["'self'"]);
  assert.deepEqual(d["frame-ancestors"], ["'none'"]);
  assert.deepEqual(d["worker-src"], ["'self'"], "MapLibre's module worker is same-origin; blob: is not allowed (HFY-TSK-310)");
  assert.equal(CSP.base.includes("http"), false, "no origin is named in the base policy");
  assert.equal(/\*/.test(CSP.base), false, "no wildcard source");
});

test("join policy: the base policy plus Turnstile (script, frame, connect) and nothing else", () => {
  const b = directives(CSP.base), j = directives(CSP.join);
  for (const k of ["img-src", "frame-ancestors", "style-src", "default-src", "worker-src"]) assert.deepEqual(j[k], b[k], k);
  assert.deepEqual(j["script-src"], [...b["script-src"], TURNSTILE]);
  assert.deepEqual(j["connect-src"], [...b["connect-src"], TURNSTILE]);
  assert.deepEqual(j["frame-src"], ["'self'", TURNSTILE]);
  assert.deepEqual(Object.keys(j).filter((k) => !(k in b)), ["frame-src"]);
  assert.deepEqual([...CSP.join.matchAll(/https?:\/\/[^\s;]+/g)].map((m) => m[0]), [TURNSTILE, TURNSTILE, TURNSTILE]);
});

test("join-csp.js holds the join policy string of site-csp.json", () => {
  assert.equal(vm.runInContext("JOIN_CSP", ctx), CSP.join);
});

test("join-csp.js swaps the header on /join/ pages, in whichever mode the policy is in", () => {
  for (const uri of ["/join", "/join/", "/join/index.html", "/Join/", "/join/?x=1"]) {
    const enforced = run(uri, { "content-security-policy": { value: CSP.base }, "content-type": { value: "text/html" } });
    assert.equal(enforced.headers["content-security-policy"].value, CSP.join, uri);
    assert.equal(enforced.headers["content-type"].value, "text/html");
    const report = run(uri, { "content-security-policy-report-only": { value: CSP.base } });
    assert.equal(report.headers["content-security-policy-report-only"].value, CSP.join, uri);
    assert.equal("content-security-policy" in report.headers, false, "report-only stays report-only: no enforcing header appears");
  }
});

test("join-csp.js leaves every other path, and a response with no CSP, untouched", () => {
  for (const uri of ["/", "/index.html", "/chat/", "/person/", "/joined/", "/joinus", "/me/join/", "/css/join.css"]) {
    const r = run(uri, { "content-security-policy": { value: CSP.base } });
    assert.equal(r.headers["content-security-policy"].value, CSP.base, uri);
  }
  const bare = run("/join/", { "content-type": { value: "text/html" } });
  assert.deepEqual(bare.headers, { "content-type": { value: "text/html" } }, "policy detached: nothing is added");
});

test("join-csp.js is ES5.1 and fits the CloudFront Function limit", () => {
  assert.ok(Buffer.byteLength(SOURCE) < 10240);
  assert.equal(/\b(let|const)\s|=>|`/.test(SOURCE.replace(/\/\/.*$/gm, "")), false, "no let/const/arrow/template literal");
});
