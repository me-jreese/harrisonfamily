#!/usr/bin/env node
// HFY-TSK-366 (ruling P2-R81): the live check for the site Content-Security-Policy. The policy has no report endpoint, so a violation
// is visible only to the browser that loads the page. This opens each page SIGNED OUT in Playwright's bundled headless shell, at 375
// and 1280 wide, and counts what the browser reports: `securitypolicyviolation` events (blocked host, effective directive,
// disposition) and console messages that mention the Content Security Policy.
//
// It only loads pages. It never signs in, types, clicks, or submits anything: no form is touched, the Turnstile widget on /join/ is
// left alone, and a non-GET document navigation is aborted before it leaves the browser. No credential, cookie or token is read or
// printed.
//
// Usage (from the repository root; needs `npm ci` in islands/ and `npx playwright install chromium-headless-shell` once):
//   node scripts/infra/check-csp-live.mjs [--site https://harrisonfamily.us] [--pages /,/join/] [--json] [--ignore-host <host>]...
// Exit: 0 only when every page loaded (HTTP 200, or an expected landing page after a redirect) under a CSP header with zero violations;
// 1 when any page failed that test; 2 for a usage or setup error. Docs: docs/how-to/add-the-site-content-security-policy.md#live-check
// The summarising and exit-code logic below is pure and unit-tested without a browser (scripts/cloudfront/test/check-csp-live.test.mjs).
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_SITE = "https://harrisonfamily.us";
export const DEFAULT_PAGES = ["/", "/join/", "/auth/login", "/family-login/", "/posts/", "/privacy/", "/terms/", "/about/", "/contact/", "/logged-out/", "/search/", "/chat/", "/me/"];
export const VIEWPORTS = [{ width: 375, height: 812 }, { width: 1280, height: 800 }];
// Signed out, some pages redirect to the sign-in page (or the page the sign-in flow ends on). These landings are expected.
export const EXPECTED_LANDINGS = [/^\/auth\//, /^\/family-login\/?$/, /^\/logged-out\/?$/];

const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** Parse argv (without node and the script). Throws an Error with a usage message on bad input. */
export function parseArgs(argv) {
  const out = { site: DEFAULT_SITE, pages: DEFAULT_PAGES.slice(), json: false, help: false, ignoreHosts: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--site") out.site = value();
    else if (a === "--ignore-host") {
      const h = value().trim().toLowerCase();
      if (!h || /[/:\s]/.test(h)) throw new Error("--ignore-host takes a bare host name such as static.example.com");
      if (!out.ignoreHosts.includes(h)) out.ignoreHosts.push(h);
    }
    else if (a === "--pages") {
      const list = value().split(",").map((p) => p.trim()).filter(Boolean).map((p) => (p.startsWith("/") ? p : `/${p}`));
      if (!list.length) throw new Error("--pages needs at least one path");
      out.pages = [...new Set(list)];
    } else throw new Error(`unknown option ${a}`);
  }
  let u;
  try { u = new URL(out.site); } catch { throw new Error(`--site is not a URL: ${out.site}`); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) {
    throw new Error("--site must be https (http only for localhost)");
  }
  out.site = u.origin;
  return out;
}

/** The host a violation blocked: a hostname, or a keyword for inline, eval, data:, blob: and the like. */
export function blockedHost(blockedURI) {
  const s = String(blockedURI ?? "").trim();
  if (!s) return "(none)";
  if (["inline", "eval", "wasm-eval", "trusted-types-policy", "trusted-types-sink", "self"].includes(s)) return s;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (!scheme) return s;
  const proto = scheme[1].toLowerCase();
  if (["data", "blob", "filesystem", "about", "mediastream"].includes(proto)) return `${proto}:`;
  try { return new URL(s).host || `${proto}:`; } catch { return s.slice(0, 80); }
}

/**
 * One console message: "violation" is Chrome's violation line, "Refused to ..." when enforced and "Loading the script ... violates the
 * following Content Security Policy directive" in report-only mode; "notice" is any other CSP mention (for example frame-ancestors being
 * ignored in a report-only policy); null if unrelated.
 */
export function classifyConsole(text) {
  const t = String(text ?? "");
  if (!/content[ -]security[ -]policy/i.test(t)) return null;
  return /\brefused to\b|violates the following content security policy directive/i.test(t) ? "violation" : "notice";
}

/** Which CSP headers the final document carried: "none" | "report-only" | "enforced" | "both". Header names are lowercase. */
export function policyOf(headers) {
  const h = headers || {};
  const ro = Boolean(h["content-security-policy-report-only"]);
  const en = Boolean(h["content-security-policy"]);
  return ro && en ? "both" : ro ? "report-only" : en ? "enforced" : "none";
}

const noQuery = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return String(u || "").split(/[?#]/)[0]; } };

/** A raw securitypolicyviolation record from the page -> a normalised one. scope is "site" for the site's own origin, else "foreign-frame". */
export function normalizeViolation(raw, siteOrigin) {
  const documentURI = String(raw.documentURI || raw.frame || "");
  let scope = "site";
  try { if (documentURI && new URL(documentURI).origin !== siteOrigin) scope = "foreign-frame"; } catch { /* keep site */ }
  return {
    directive: String(raw.effectiveDirective || raw.violatedDirective || "unknown"),
    blockedHost: blockedHost(raw.blockedURI),
    disposition: raw.disposition === "enforce" ? "enforce" : "report",
    source: noQuery(raw.sourceFile || ""),
    scope
  };
}

/** Whether a final URL is where this page may legitimately land. */
export function isExpectedLanding(requestedPath, finalUrl, siteOrigin) {
  let u;
  try { u = new URL(finalUrl); } catch { return false; }
  if (u.origin !== siteOrigin) return false;
  if (trimSlash(u.pathname) === trimSlash(requestedPath.split(/[?#]/)[0])) return true;
  return EXPECTED_LANDINGS.some((re) => re.test(u.pathname));
}

/**
 * Summarise the per-page, per-width results of a run. `results` entries:
 *   { page, width, status, finalUrl, headers?, policy?, violations: [raw], consoleMessages: [text], error? }
 * Returns { ok, exitCode, site, totals, pages: [...], groups: [...] }; `pages[i].ok` is true only when it loaded (HTTP 200 at an expected
 * landing), carried a CSP header, and had zero site violations and zero console violation messages.
 */
export function summarize(results, { site = DEFAULT_SITE, ignoreHosts = [] } = {}) {
  const origin = new URL(site).origin;
  const groups = new Map();
  const pages = results.map((r) => {
    const all = (r.violations || []).map((v) => normalizeViolation(v, origin));
    const ignored = (host) => ignoreHosts.includes(String(host).toLowerCase());
    const mine = all.filter((v) => v.scope === "site" && !ignored(v.blockedHost));
    const foreign = all.filter((v) => v.scope !== "site").length;
    const blocking = mine.filter((v) => v.disposition === "enforce").length;
    const reportOnly = mine.length - blocking;
    const consoleKinds = (r.consoleMessages || [])
      .filter((m) => !ignoreHosts.some((h) => String(m).toLowerCase().includes(`//${h}`)))
      .map(classifyConsole);
    const consoleViolations = consoleKinds.filter((k) => k === "violation").length;
    const consoleNotices = consoleKinds.filter((k) => k === "notice").length;
    const policy = r.policy || policyOf(r.headers);
    const finalUrl = r.finalUrl ? noQuery(r.finalUrl) : "";
    const redirected = Boolean(finalUrl) && trimSlash(new URL(finalUrl).pathname) !== trimSlash(r.page.split(/[?#]/)[0]);
    const problems = [];
    if (r.error) problems.push(`load failed: ${String(r.error).slice(0, 120)}`);
    else if (r.status !== 200) problems.push(`HTTP ${r.status ?? "none"}`);
    if (!r.error && r.finalUrl && !isExpectedLanding(r.page, r.finalUrl, origin)) problems.push(`unexpected landing ${finalUrl}`);
    if (!r.error && policy === "none") problems.push("no CSP header on the final document");
    if (mine.length) problems.push(`${mine.length} violation${mine.length === 1 ? "" : "s"}`);
    if (consoleViolations) problems.push(`${consoleViolations} console violation message${consoleViolations === 1 ? "" : "s"}`);
    for (const v of mine) {
      const key = [r.page, v.directive, v.blockedHost, v.disposition].join("\u0000");
      const g = groups.get(key) || { page: r.page, directive: v.directive, blockedHost: v.blockedHost, disposition: v.disposition, widths: new Set(), count: 0 };
      g.count += 1;
      g.widths.add(r.width);
      groups.set(key, g);
    }
    return {
      page: r.page, width: r.width, status: r.status ?? null, finalUrl, redirected, policy,
      violations: mine.length, blocking, reportOnly, consoleViolations, consoleNotices, foreign,
      ok: problems.length === 0, problems
    };
  });
  const sum = (k) => pages.reduce((n, p) => n + p[k], 0);
  const totals = {
    loads: pages.length, loaded: pages.filter((p) => p.status === 200 && !p.problems.some((x) => x.startsWith("load failed"))).length,
    failed: pages.filter((p) => !p.ok).length, violations: sum("violations"), blocking: sum("blocking"), reportOnly: sum("reportOnly"),
    consoleViolations: sum("consoleViolations"), consoleNotices: sum("consoleNotices"), foreign: sum("foreign")
  };
  const ok = pages.length > 0 && totals.failed === 0;
  return {
    ok, exitCode: ok ? 0 : 1, site: origin, totals, pages,
    groups: [...groups.values()].map((g) => ({ ...g, widths: [...g.widths].sort((a, b) => a - b) }))
  };
}

/** The exit code for a summary (0 only when every page was fine). */
export const exitCodeOf = (summary) => (summary && summary.ok && summary.pages.length > 0 ? 0 : 1);

const pad = (s, n) => String(s).padEnd(n);
/** The one table, then the violation groups and the problems. */
export function formatTable(summary) {
  const cols = [["PAGE", 16], ["W", 5], ["HTTP", 5], ["POLICY", 12], ["VIOL", 5], ["ENFORCED", 9], ["REPORT", 7], ["CONSOLE", 8], ["LANDED", 22], ["OK", 3]];
  const lines = [cols.map(([h, n]) => pad(h, n)).join(" ").trimEnd()];
  for (const p of summary.pages) {
    let landed = "-";
    if (p.finalUrl) { try { landed = p.redirected ? new URL(p.finalUrl).pathname : "(same)"; } catch { landed = "?"; } }
    lines.push([p.page, p.width, p.status ?? "-", p.policy, p.violations, p.blocking, p.reportOnly, p.consoleViolations, landed, p.ok ? "yes" : "NO"]
      .map((v, i) => pad(v, cols[i][1])).join(" ").trimEnd());
  }
  const t = summary.totals;
  lines.push("", `${summary.site}: ${t.loads} loads, ${t.loaded} loaded, ${t.violations} violations (${t.blocking} enforced, ${t.reportOnly} report-only), ` +
    `${t.consoleViolations} console violation lines, ${t.consoleNotices} other CSP notices, ${t.foreign} from foreign frames (not counted) -> ${summary.ok ? "PASS" : "FAIL"}`);
  if (summary.groups.length) {
    lines.push("", "Violations (page, directive, blocked host, disposition, widths, count):");
    for (const g of summary.groups) lines.push(`  ${g.page}  ${g.directive}  ${g.blockedHost}  ${g.disposition}  ${g.widths.join("+")}  x${g.count}`);
  }
  const bad = summary.pages.filter((p) => !p.ok);
  if (bad.length) {
    lines.push("", "Failing loads:");
    for (const p of bad) lines.push(`  ${p.page} @${p.width}: ${p.problems.join("; ")}`);
  }
  return lines.join("\n");
}

/** The machine-readable line: per-page counts plus the violation groups. No cookies, headers or query strings. */
export function jsonLine(summary, at = new Date().toISOString()) {
  return JSON.stringify({
    tool: "check-csp-live", at, site: summary.site, ok: summary.ok, exitCode: summary.exitCode, totals: summary.totals,
    pages: summary.pages.map(({ page, width, status, finalUrl, policy, violations, blocking, reportOnly, consoleViolations, consoleNotices, foreign, ok }) =>
      ({ page, width, status, finalUrl, policy, violations, blocking, reportOnly, consoleViolations, consoleNotices, foreign, ok })),
    violations: summary.groups
  });
}

// ---- browser part: only reached when the file is run, never when it is imported by the unit test ----

const USAGE = `Usage: node scripts/infra/check-csp-live.mjs [--site <https url>] [--pages </a,/b/>] [--json]
  Loads each page signed out at 375 and 1280 wide in Playwright's bundled headless shell and counts CSP violations.
  Exit 0 only when every page loaded with zero violations; 1 otherwise; 2 for a usage or setup error.
  --json prints only the machine-readable JSON line.
  --ignore-host <host> leaves out violations whose blocked host is exactly <host> (repeatable, default none).`;

// Reports every violation to Node (so it survives a redirect) and keeps a copy in window.__csp.
const INIT_SCRIPT = () => {
  window.__csp = window.__csp || [];
  document.addEventListener("securitypolicyviolation", (e) => {
    const rec = { effectiveDirective: e.effectiveDirective, violatedDirective: e.violatedDirective, blockedURI: e.blockedURI, disposition: e.disposition,
      sourceFile: e.sourceFile || "", documentURI: e.documentURI || location.href };
    window.__csp.push(rec);
    try { if (typeof window.__cspReport === "function") window.__cspReport(rec); } catch { /* the page is going away */ }
  }, true);
};

async function loadPlaywright() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  try { return createRequire(join(root, "islands", "package.json"))("@playwright/test").chromium; } catch (e) {
    throw new Error(`cannot load Playwright from islands/node_modules (run \`cd islands && npm ci\`): ${e.message.split("\n")[0]}`);
  }
}

async function checkOne(browser, site, path, viewport, log) {
  const context = await browser.newContext({ viewport, serviceWorkers: "allow" });
  const result = { page: path, width: viewport.width, status: null, finalUrl: "", headers: {}, violations: [], consoleMessages: [], error: null };
  try {
    // A fresh context per load keeps every load signed out and cache-cold. Never submit: abort any non-GET document navigation.
    await context.route("**/*", (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && !["GET", "HEAD"].includes(req.method())) { log(`  aborted a ${req.method()} navigation to ${noQuery(req.url())}`); return route.abort(); }
      return route.continue();
    });
    await context.exposeFunction("__cspReport", (rec) => { result.violations.push(rec); });
    await context.addInitScript(INIT_SCRIPT);
    const page = await context.newPage();
    let last = null;
    page.on("response", (r) => { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) last = r; });
    page.on("console", (m) => { const t = m.text(); if (classifyConsole(t)) result.consoleMessages.push(t.slice(0, 300)); });
    try {
      await page.goto(new URL(path, site).href, { waitUntil: "load", timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {}); // chat keeps a socket open: idle may never come
      await page.waitForTimeout(3_000);
    } catch (e) { result.error = String(e.message || e).split("\n")[0]; }
    result.finalUrl = page.url();
    if (last) { result.status = last.status(); result.headers = last.headers(); }
  } catch (e) { result.error = result.error || String(e.message || e).split("\n")[0]; } finally { await context.close().catch(() => {}); }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(`check-csp-live: ${e.message}\n${USAGE}`); return 2; }
  if (opts.help) { console.log(USAGE); return 0; }
  const log = (s) => console.error(s);
  let chromium;
  try { chromium = await loadPlaywright(); } catch (e) { console.error(`check-csp-live: ${e.message}`); return 2; }
  let browser;
  try { browser = await chromium.launch({ channel: "chromium-headless-shell", headless: true }); } catch (e) {
    console.error(`check-csp-live: cannot launch the bundled headless shell (run \`cd islands && npx playwright install chromium-headless-shell\`): ${String(e.message).split("\n")[0]}`);
    return 2;
  }
  const results = [];
  try {
    for (const viewport of VIEWPORTS) {
      for (const path of opts.pages) {
        log(`loading ${path} @${viewport.width}`);
        results.push(await checkOne(browser, opts.site, path, viewport, log));
      }
    }
  } finally { await browser.close().catch(() => {}); }
  const summary = summarize(results, { site: opts.site, ignoreHosts: opts.ignoreHosts });
  if (!opts.json) console.log(formatTable(summary) + "\n");
  console.log(jsonLine(summary));
  return exitCodeOf(summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`check-csp-live: ${e.stack || e}`); process.exitCode = 2; });
}
