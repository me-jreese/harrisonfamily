// HFY-TSK-366 (ruling P2-R81): the pure summarising and exit-code logic of scripts/infra/check-csp-live.mjs. No browser and no network.
// Run: node --test scripts/cloudfront/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PAGES, blockedHost, classifyConsole, exitCodeOf, formatTable, isExpectedLanding, jsonLine, normalizeViolation, parseArgs, policyOf, summarize }
  from "../../infra/check-csp-live.mjs";

const SITE = "https://site.example";
const ro = { "content-security-policy-report-only": "default-src 'self'" };
const load = (page, over = {}) => ({ page, width: 375, status: 200, finalUrl: `${SITE}${page}`, headers: ro, violations: [], consoleMessages: [], ...over });
const viol = (over = {}) => ({ effectiveDirective: "img-src", blockedURI: "https://cdn.example/a.png?x=1", disposition: "report", documentURI: `${SITE}/join/`, ...over });

test("blockedHost: hostnames, and keywords for inline, eval, data: and blob:", () => {
  assert.equal(blockedHost("https://cdn.example/a.png?x=1"), "cdn.example");
  assert.equal(blockedHost("wss://site.example:8443/chat/ws"), "site.example:8443");
  assert.equal(blockedHost("inline"), "inline");
  assert.equal(blockedHost("eval"), "eval");
  assert.equal(blockedHost("data:image/png;base64,AAAA"), "data:");
  assert.equal(blockedHost("blob:https://site.example/1234"), "blob:");
  assert.equal(blockedHost(""), "(none)");
  assert.equal(blockedHost(undefined), "(none)");
});

test("classifyConsole: Chrome's enforced and report-only violation lines are violations, other CSP mentions are notices, the rest is ignored", () => {
  assert.equal(classifyConsole("Refused to load the image 'https://x.example/a.png' because it violates the following Content Security Policy directive: \"img-src 'self'\"."), "violation");
  assert.equal(classifyConsole("Loading the script 'https://x.example/a.js' violates the following Content Security Policy directive: \"script-src 'self'\". Note that 'script-src-elem' was not explicitly set."), "violation");
  assert.equal(classifyConsole("The Content Security Policy directive 'frame-ancestors' is ignored when delivered in a report-only policy."), "notice");
  assert.equal(classifyConsole("Failed to load resource: net::ERR_FAILED"), null);
  assert.equal(classifyConsole(undefined), null);
});

test("policyOf: report-only, enforced, both, none", () => {
  assert.equal(policyOf({ "content-security-policy-report-only": "x" }), "report-only");
  assert.equal(policyOf({ "content-security-policy": "x" }), "enforced");
  assert.equal(policyOf({ "content-security-policy": "x", "content-security-policy-report-only": "y" }), "both");
  assert.equal(policyOf({}), "none");
  assert.equal(policyOf(undefined), "none");
});

test("normalizeViolation: directive, blocked host, disposition; another origin's frame is a foreign-frame", () => {
  const v = normalizeViolation(viol({ sourceFile: `${SITE}/js/a.js?v=1` }), SITE);
  assert.deepEqual(v, { directive: "img-src", blockedHost: "cdn.example", disposition: "report", source: `${SITE}/js/a.js`, scope: "site" });
  assert.equal(normalizeViolation(viol({ disposition: "enforce" }), SITE).disposition, "enforce");
  assert.equal(normalizeViolation(viol({ documentURI: "https://challenges.example/frame" }), SITE).scope, "foreign-frame");
  assert.equal(normalizeViolation({ violatedDirective: "script-src-elem", blockedURI: "inline" }, SITE).directive, "script-src-elem");
});

test("isExpectedLanding: the page itself, the sign-in pages and the logged-out page; nothing off the site", () => {
  assert.equal(isExpectedLanding("/join/", `${SITE}/join/`, SITE), true);
  assert.equal(isExpectedLanding("/auth/login", `${SITE}/auth/login/`, SITE), true);
  assert.equal(isExpectedLanding("/me/", `${SITE}/auth/login?returnTo=%2Fme%2F`, SITE), true);
  assert.equal(isExpectedLanding("/family-login/", `${SITE}/auth/login`, SITE), true);
  assert.equal(isExpectedLanding("/chat/", `${SITE}/logged-out/`, SITE), true);
  assert.equal(isExpectedLanding("/me/", "https://accounts.example/signin", SITE), false);
  assert.equal(isExpectedLanding("/me/", `${SITE}/somewhere-else/`, SITE), false);
});

test("a clean run exits 0: every load is HTTP 200 under a CSP header with no violation", () => {
  const s = summarize([load("/"), load("/join/"), load("/me/", { finalUrl: `${SITE}/auth/login?returnTo=%2Fme%2F` }), load("/", { width: 1280 })], { site: SITE });
  assert.equal(s.ok, true);
  assert.equal(s.exitCode, 0);
  assert.equal(exitCodeOf(s), 0);
  assert.equal(s.totals.loads, 4);
  assert.equal(s.totals.loaded, 4);
  assert.equal(s.totals.violations, 0);
  assert.equal(s.pages[2].redirected, true);
  assert.equal(s.pages[2].finalUrl, `${SITE}/auth/login`, "the query string is dropped");
});

test("a violation fails the run, is counted per page and width, and is grouped by directive and blocked host", () => {
  const s = summarize([
    load("/join/", { violations: [viol(), viol({ effectiveDirective: "frame-src", blockedURI: "https://other.example/x", disposition: "enforce" })] }),
    load("/join/", { width: 1280, violations: [viol()] }),
    load("/")
  ], { site: SITE });
  assert.equal(s.exitCode, 1);
  assert.equal(exitCodeOf(s), 1);
  assert.deepEqual([s.pages[0].violations, s.pages[0].blocking, s.pages[0].reportOnly], [2, 1, 1]);
  assert.equal(s.pages[1].violations, 1);
  assert.equal(s.pages[2].ok, true);
  assert.equal(s.totals.violations, 3);
  assert.equal(s.totals.blocking, 1);
  const img = s.groups.find((g) => g.directive === "img-src");
  assert.deepEqual({ page: img.page, host: img.blockedHost, count: img.count, widths: img.widths }, { page: "/join/", host: "cdn.example", count: 2, widths: [375, 1280] });
  assert.equal(s.groups.length, 2);
});

test("a page that did not load fails the run: non-200, a load error, an unexpected landing, or no CSP header", () => {
  for (const [name, row] of [
    ["404", load("/about/", { status: 404 })],
    ["error", load("/about/", { status: null, finalUrl: "", error: "net::ERR_CONNECTION_REFUSED" })],
    ["off-site landing", load("/me/", { finalUrl: "https://accounts.example/signin" })],
    ["unexpected landing", load("/me/", { finalUrl: `${SITE}/elsewhere/` })],
    ["no CSP header", load("/about/", { headers: {} })]
  ]) {
    const s = summarize([load("/"), row], { site: SITE });
    assert.equal(s.exitCode, 1, name);
    assert.equal(s.pages[1].ok, false, name);
    assert.ok(s.pages[1].problems.length > 0, name);
  }
  assert.equal(summarize([load("/about/", { status: null, finalUrl: "", error: "boom" })], { site: SITE }).totals.loaded, 0);
});

test("console messages: a console violation line fails the run, a notice does not, and foreign-frame violations are listed but not counted", () => {
  const refused = summarize([load("/", { consoleMessages: ["Loading the script 'https://x.example/a.js' violates the following Content Security Policy directive: \"script-src 'self'\"."] })], { site: SITE });
  assert.equal(refused.exitCode, 1);
  assert.equal(refused.pages[0].consoleViolations, 1);
  const notice = summarize([load("/", { consoleMessages: ["The Content Security Policy directive 'frame-ancestors' is ignored when delivered in a report-only policy."] })], { site: SITE });
  assert.equal(notice.exitCode, 0);
  assert.equal(notice.pages[0].consoleNotices, 1);
  const foreign = summarize([load("/join/", { violations: [viol({ documentURI: "https://challenges.example/frame" })] })], { site: SITE });
  assert.equal(foreign.exitCode, 0);
  assert.equal(foreign.pages[0].foreign, 1);
  assert.equal(foreign.totals.violations, 0);
});

test("no results is a failure, never a pass", () => {
  const s = summarize([], { site: SITE });
  assert.equal(s.ok, false);
  assert.equal(s.exitCode, 1);
  assert.equal(exitCodeOf(s), 1);
});

test("jsonLine is one line of JSON with per-page counts and no headers; formatTable names the verdict", () => {
  const s = summarize([load("/join/", { violations: [viol()] }), load("/", { width: 1280 })], { site: SITE });
  const line = jsonLine(s, "2026-11-04T00:00:00.000Z");
  assert.equal(line.includes("\n"), false);
  const j = JSON.parse(line);
  assert.equal(j.tool, "check-csp-live");
  assert.equal(j.ok, false);
  assert.equal(j.exitCode, 1);
  assert.deepEqual(j.pages[0], { page: "/join/", width: 375, status: 200, finalUrl: `${SITE}/join/`, policy: "report-only", violations: 1, blocking: 0, reportOnly: 1, consoleViolations: 0, consoleNotices: 0, foreign: 0, ok: false });
  assert.equal(j.violations[0].blockedHost, "cdn.example");
  assert.equal(line.includes("content-security-policy"), false, "no raw headers in the JSON");
  const table = formatTable(s);
  assert.match(table, /^PAGE\s+W\s+HTTP/);
  assert.match(table, /FAIL/);
  assert.match(table, /\/join\/\s+375\s+200\s+report-only\s+1\s+0\s+1/);
  assert.match(formatTable(summarize([load("/")], { site: SITE })), /PASS/);
});

test("parseArgs: defaults, --site, --pages, --json; bad input throws", () => {
  const d = parseArgs([]);
  assert.equal(d.site, "https://harrisonfamily.us");
  assert.deepEqual(d.pages, DEFAULT_PAGES);
  assert.equal(d.json, false);
  assert.ok(["/", "/join/", "/auth/login", "/family-login/", "/posts/", "/privacy/", "/terms/", "/about/", "/contact/", "/logged-out/", "/search/", "/chat/", "/me/"].every((p) => d.pages.includes(p)));
  const o = parseArgs(["--site", "https://site.example/ignored/path", "--pages", "/join/, privacy/,/join/", "--json"]);
  assert.deepEqual(o, { site: "https://site.example", pages: ["/join/", "/privacy/"], json: true, help: false });
  assert.equal(parseArgs(["--site", "http://127.0.0.1:8089"]).site, "http://127.0.0.1:8089");
  assert.throws(() => parseArgs(["--site", "http://site.example"]), /https/);
  assert.throws(() => parseArgs(["--site", "not a url"]), /not a URL/);
  assert.throws(() => parseArgs(["--pages"]), /needs a value/);
  assert.throws(() => parseArgs(["--click"]), /unknown option/);
});
