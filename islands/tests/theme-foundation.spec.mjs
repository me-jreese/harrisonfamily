// HFY design-system pass (P0 foundation): the theme reaches every page from the first paint, with the self-hosted brand faces,
// before and without any island. /_data/flags.json and /js/islands/* are held back 1.5 s, so everything asserted at
// domcontentloaded comes from the static head blocks and /css/hfy-theme.css alone. /auth and /api are stubbed (signed out).
// Run against a scratch build: HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/theme-foundation.spec.mjs
import { test, expect } from "@playwright/test";

const PAGES = ["/", "/about/", "/search/", "/privacy/", "/posts/", "/me/notifications/", "/offline.html"];
const NO_FOCUS_TARGET = new Set(["/me/notifications/"]); // nothing focusable before the island mounts
const SURFACE = "rgb(20, 18, 16)"; // archive-950
const TEXT = "rgb(250, 246, 238)"; // archive-50
const FOCUS = "rgb(255, 193, 7)"; // gold-400
const PRINT_SURFACE = "rgb(243, 236, 223)"; // archive-100
const FAMILIES = ["Source Sans 3", "Libre Caslon Text", "Source Code Pro"];
const HOLD_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stubs(page, { holdFlags = true, holdIslands = true } = {}) {
  const log = { thirdPartyFonts: [], flagsServed: false, islands: [] };
  page.on("request", (q) => { if (/googleapis\.com|gstatic\.com/.test(q.url())) log.thirdPartyFonts.push(q.url()); });
  await page.route(/accounts\.google\.com|googleapis\.com|gstatic\.com/, (r) => r.abort());
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { code: "AUTH_REFRESH_FAILED" } }));
  await page.route("**/auth/login**", (r) => r.fulfill({ contentType: "text/html", body: "<h1>edge login</h1>" }));
  await page.route("**/api/**", (r) => r.fulfill({ status: 401, json: { error: "unauthorized" } }));
  await page.route("**/_data/flags.json", async (r) => {
    if (holdFlags) await sleep(HOLD_MS);
    log.flagsServed = true;
    return r.continue().catch(() => {});
  });
  await page.route("**/js/islands/**", async (r) => {
    log.islands.push(new URL(r.request().url()).pathname);
    if (holdIslands) await sleep(HOLD_MS);
    return r.continue().catch(() => {});
  });
  return log;
}

const bodyStyle = (page) => page.evaluate(() => {
  const s = getComputedStyle(document.body);
  return { bg: s.backgroundColor, color: s.color, font: s.fontFamily, scheme: getComputedStyle(document.documentElement).colorScheme };
});

for (const viewport of [{ width: 375, height: 812 }, { width: 1024, height: 768 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    for (const path of PAGES) {
      test(`${path}: themed at first paint with the brand faces, before any island`, async ({ page }) => {
        const log = await stubs(page);
        await page.goto(path, { waitUntil: "domcontentloaded" });
        // nothing from the flags or the islands has run yet
        expect(log.flagsServed).toBe(false);
        expect(await page.locator('script[src^="/js/islands/"]').count()).toBe(0);
        expect(await page.locator('link[href^="/css/hfy-theme.css"]').count()).toBe(1);
        const s = await bodyStyle(page);
        expect(s.bg).toBe(SURFACE);
        expect(s.color).toBe(TEXT);
        expect(s.font).toMatch(/^"?Source Sans 3"?(,|$)/);
        expect(s.scheme).toBe("dark");
        expect(await page.locator('meta[name="theme-color"]').getAttribute("content")).toBe("#141210");

        if (!NO_FOCUS_TARGET.has(path)) {
          await page.keyboard.press("Tab");
          const ring = await page.evaluate(() => {
            const el = document.activeElement;
            if (!el || el === document.body) return null;
            const s = getComputedStyle(el);
            return { tag: el.tagName, style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, offset: s.outlineOffset };
          });
          expect(ring, "Tab focuses an element").not.toBeNull();
          expect({ style: ring.style, width: ring.width, color: ring.color, offset: ring.offset }, `focus ring on ${ring.tag}`)
            .toEqual({ style: "solid", width: "2px", color: FOCUS, offset: "2px" });
        }

        // the three self-hosted families load from /fonts/ (same origin) and nowhere else
        const loaded = await page.evaluate(async (families) => {
          await document.fonts.ready;
          await Promise.all(families.map((f) => document.fonts.load(`16px "${f}"`)));
          return families.map((f) => document.fonts.check(`16px "${f}"`));
        }, FAMILIES);
        expect(loaded).toEqual([true, true, true]);
        const fontUrls = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\.woff2(\?|$)/.test(n)));
        expect(fontUrls.length).toBeGreaterThan(0);
        for (const u of fontUrls) expect(new URL(u).pathname).toMatch(/^\/fonts\/[\w-]+\.[0-9a-f]{8}\.woff2$/);
        expect(log.thirdPartyFonts).toEqual([]);
      });
    }
  });
}

test("the shell early hint: html.hfy-shell-v2 is set before the flags fetch resolves", async ({ page }) => {
  const log = await stubs(page);
  await page.addInitScript(() => { try { localStorage.setItem("hfy:shell-hint", "1"); } catch {} });
  await page.goto("/about/", { waitUntil: "domcontentloaded" });
  expect(log.flagsServed).toBe(false);
  expect(await page.evaluate(() => document.documentElement.classList.contains("hfy-shell-v2"))).toBe(true);
  expect((await bodyStyle(page)).bg).toBe(SURFACE);
});

test("the hint is written only after the shell loaded; a 404 shell removes the class, writes '0' and keeps the theme", async ({ page }) => {
  await stubs(page, { holdFlags: false, holdIslands: false });
  await page.addInitScript(() => { try { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("hfy:shell-hint", "1"); } } catch {} });
  await page.route("**/js/islands/shell.js*", (r) => r.fulfill({ status: 404, body: "not found" }));
  await page.goto("/about/?hfy_flags=shellV2");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("hfy:shell-hint"))).toBe("0");
  expect(await page.evaluate(() => document.documentElement.classList.contains("hfy-shell-v2"))).toBe(false);
  expect(await page.locator('link[href^="/css/hfy-theme.css"]').count()).toBe(1);
  expect((await bodyStyle(page)).bg).toBe(SURFACE);
  await expect(page.locator("nav.navbar-hf")).toBeVisible();
});

test("a shell that loads writes the hint '1'; with the flag forced off the hint is '0' and the class is dropped", async ({ page }) => {
  await stubs(page, { holdFlags: false, holdIslands: false });
  await page.goto("/about/?hfy_flags=shellV2");
  await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("hfy:shell-hint"))).toBe("1");
  await page.goto("/about/?hfy_flags=-shellV2,-searchV2");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("hfy:shell-hint"))).toBe("0");
  expect(await page.evaluate(() => document.documentElement.classList.contains("hfy-shell-v2"))).toBe(false);
});

test("islands load CSS first: the module is requested only after its stylesheet settled", async ({ page }) => {
  await stubs(page, { holdFlags: false, holdIslands: false });
  const order = [];
  await page.route("**/js/islands/shell.css*", async (r) => { await sleep(800); order.push("css-done"); return r.continue(); });
  page.on("request", (q) => { if (new URL(q.url()).pathname === "/js/islands/shell.js") order.push("js-requested"); });
  await page.goto("/about/?hfy_flags=shellV2");
  await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
  expect(order.slice(0, 2)).toEqual(["css-done", "js-requested"]);
});

test("a page that lost head block B still gets the theme from feature-flags.js", async ({ page }) => {
  await stubs(page, { holdFlags: false, holdIslands: false });
  await page.route("**/about/", async (r) => {
    const res = await r.fetch();
    const body = (await res.text()).replace(/<!-- hfy-theme:start B -->[\s\S]*?<!-- hfy-theme:end B -->/, "");
    return r.fulfill({ response: res, body });
  });
  await page.goto("/about/");
  await expect(page.locator("link[data-hfy-theme-fallback]")).toHaveCount(1);
  await expect.poll(async () => (await bodyStyle(page)).bg).toBe(SURFACE);
  // appended after main.css, so the theme still wins the cascade
  expect(await page.evaluate(() => {
    const links = [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute("href").replace(/\?v=[0-9a-f]{8}$/, ""));
    return links.indexOf("/css/main.css") < links.indexOf("/css/hfy-theme.css");
  })).toBe(true);
});

test("print gets the daylight theme without JS", async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1024, height: 768 } });
  const page = await ctx.newPage();
  await page.route(/accounts\.google\.com|googleapis\.com|gstatic\.com/, (r) => r.abort());
  for (const path of ["/about/", "/offline.html"]) {
    await page.goto(path);
    expect((await bodyStyle(page)).bg).toBe(SURFACE);
    await page.emulateMedia({ media: "print" });
    const s = await bodyStyle(page);
    expect(s.bg).toBe(PRINT_SURFACE);
    expect(s.scheme).toBe("light");
    await page.emulateMedia({ media: "screen" });
  }
  await ctx.close();
});

test("the offline page reads in the family voice and offers one retry action", async ({ page }) => {
  await stubs(page);
  await page.goto("/offline.html");
  await expect(page.locator("h1")).toHaveText("you're offline.");
  await expect(page.getByText("the pages you already opened still work.")).toBeVisible();
  const retry = page.getByRole("link", { name: "try again" });
  await expect(retry).toBeVisible();
  const box = await retry.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector("h1")).fontFamily)).toMatch(/^"?Libre Caslon Text"?,/);
});
