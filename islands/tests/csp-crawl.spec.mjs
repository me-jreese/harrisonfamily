// HFY-TSK-149 (review PS-11): the report-only gate for the site Content-Security-Policy. Every page of the committed site is opened
// at 375 and 1280, signed out and signed in, with every flag on through ?hfy_flags, under the policy that CloudFront attaches
// (scripts/cloudfront/site-csp.json; /join/ gets its Turnstile variant, as scripts/cloudfront/join-csp.js does). Playwright adds the
// header as Content-Security-Policy-Report-Only to each document, so a violation is reported and nothing is blocked; the page-side
// securitypolicyviolation listener collects them. The edge, the data and Turnstile are stubbed; synthetic answers only. The crawl
// passes at ZERO violations: that is the condition for add-csp-headers.sh --mode enforce. The controls prove the harness would
// notice a third-party image, connection or script, so zero is a measurement and not a blind spot.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/csp-crawl.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SITE = resolve(process.env.HFY_SITE || "../11ty");
const CSP = JSON.parse(readFileSync(new URL("../../scripts/cloudfront/site-csp.json", import.meta.url), "utf8"));
const FLAGS = Object.keys(JSON.parse(readFileSync(join(SITE, "_data/flags.json"), "utf8")));
const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]];
const HEADER = "content-security-policy-report-only";

/** Every page the site serves: each index.html under the site (as its clean URL) plus offline.html, and a person page with an id. */
function pages() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "js" || name === "css" || name === "fonts" || name === "images") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === "index.html") out.push("/" + relative(SITE, dir).split("\\").join("/") + (dir === SITE ? "" : "/"));
    }
  };
  walk(SITE);
  out.push("/offline.html", "/person/?id=I9001");
  return [...new Set(out)].sort();
}
const PAGES = pages();
const policyFor = (pathname) => (pathname === "/join" || pathname.startsWith("/join/") ? CSP.join : CSP.base);

const SIGNED_IN = { authenticated: true, sub: "I9001", grampsId: "I9001", label: "Sam Example" };

async function harness(page, { signedIn }) {
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push({ directive: e.effectiveDirective, blocked: e.blockedURI, disposition: e.disposition, source: e.sourceFile || "", sample: e.sample || "" }));
  });
  // lowest priority (registered first): add the header to every document the static server answers
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.resourceType() !== "document") return route.continue();
    const resp = await route.fetch();
    return route.fulfill({ response: resp, headers: { ...resp.headers(), [HEADER]: policyFor(new URL(req.url()).pathname) } });
  });
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/auth/session", (r) => r.fulfill({ json: signedIn ? SIGNED_IN : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: signedIn ? 200 : 401, json: signedIn ? { exp: Math.floor(Date.now() / 1000) + 3600 } : { error: "no refresh" } }));
  await page.route("**/auth/login**", (r) => r.fulfill({ contentType: "text/html", body: "<h1>edge login</h1>" }));
  await page.route("**/auth/access-request/config", (r) => r.fulfill({ json: { open: true, turnstileSiteKey: "1x-test-site-key" } }));
  await page.route("**/api/**", (r) => r.fulfill({ json: {} }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route(/\/person\/I\d+\.json/, (r) => r.fulfill({ json: {} }));
  await page.route(/challenges\.cloudflare\.com\/turnstile/, (r) => r.fulfill({ contentType: "text/javascript", body: "window.turnstile={render:function(e,o){o.callback('t');return 1},reset:function(){},remove:function(){}};" }));
}

const violations = (page) => page.evaluate(() => window.__csp || []);
async function settle(page) {
  await page.waitForLoadState("load");
  await page.waitForTimeout(400); // islands mount and fetch after load
}

for (const signedIn of [false, true]) {
  for (const [vp, size] of VIEWPORTS) {
    test(`crawl ${signedIn ? "signed in" : "signed out"} at ${vp}: every page, every flag on, zero violations`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(size);
      await harness(page, { signedIn });
      const found = [];
      for (const path of PAGES) {
        const url = path + (path.includes("?") ? "&" : "?") + "hfy_flags=" + FLAGS.join(",");
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await settle(page);
        for (const v of await violations(page)) found.push({ page: path, ...v });
      }
      expect(PAGES.length, "the crawl found the site's pages").toBeGreaterThan(15);
      expect(found, "a page breaks the policy: fix the page, or the policy before it is enforced").toEqual([]);
    });
  }
}

test("control: a third-party image, connection and script on a normal page are all reported (so zero above means zero)", async ({ page }) => {
  await harness(page, { signedIn: false });
  await page.goto("/about/", { waitUntil: "domcontentloaded" });
  await settle(page);
  await page.evaluate(() => {
    const img = document.createElement("img"); img.src = "https://example.invalid/pixel.png"; document.body.appendChild(img);
    fetch("https://example.invalid/collect").catch(() => {});
    const s = document.createElement("script"); s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; document.head.appendChild(s);
  });
  await page.waitForTimeout(600);
  const v = await violations(page);
  const directives = v.map((x) => x.directive);
  expect(directives).toEqual(expect.arrayContaining(["img-src", "connect-src"]));
  expect(directives.some((d) => d.startsWith("script-src"))).toBe(true);
  expect(v.every((x) => x.disposition === "report"), "report-only: nothing is blocked").toBe(true);
});

test("control: /join/ loads Turnstile with zero violations, and still reports any other third party", async ({ page }) => {
  await harness(page, { signedIn: false });
  await page.goto("/join/?hfy_flags=" + FLAGS.join(","), { waitUntil: "domcontentloaded" });
  await settle(page);
  await page.evaluate(() => { const s = document.createElement("script"); s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; document.head.appendChild(s); });
  await page.waitForTimeout(400);
  expect(await violations(page)).toEqual([]);
  await page.evaluate(() => { const img = document.createElement("img"); img.src = "https://example.invalid/pixel.png"; document.body.appendChild(img); });
  await page.waitForTimeout(400);
  expect((await violations(page)).map((x) => x.directive)).toEqual(["img-src"]);
});

test("control: a same-origin module worker is allowed (worker-src 'self'), a blob: worker is reported (HFY-TSK-310)", async ({ page }) => {
  await harness(page, { signedIn: false });
  await page.route("**/csp-probe-worker.js", (r) => r.fulfill({ contentType: "text/javascript", body: "postMessage('ok');" }));
  await page.goto("/about/", { waitUntil: "domcontentloaded" });
  await settle(page);
  await page.evaluate(() => { const w = new Worker("/csp-probe-worker.js", { type: "module" }); w.onerror = () => {}; });
  await page.waitForTimeout(400);
  expect(await violations(page), "a same-origin module worker is not a violation").toEqual([]);
  await page.evaluate(() => { try { new Worker(URL.createObjectURL(new Blob(["1"], { type: "text/javascript" }))); } catch {} });
  await page.waitForTimeout(400);
  const v = await violations(page);
  expect(v.map((x) => x.directive)).toEqual(["worker-src"]);
  expect(v[0].disposition).toBe("report");
});
