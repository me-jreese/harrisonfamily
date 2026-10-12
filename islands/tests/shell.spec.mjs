// HFY-TSK-064 AC2/AC3: shell on/off at 375px. Run: npm test (needs `npm run build:islands` first).
import { test, expect } from "@playwright/test";

const PAGES = ["/", "/about/", "/search/", "/private/"];

async function audit(page) {
  return page.evaluate(() => {
    const chrome = document.querySelector("#hfy-shell-root");
    const small = [];
    chrome.querySelectorAll("a[href], button, [role=button], input, select, textarea").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return; // not rendered
      if (el.closest(".hfy-content")) return; // legacy page body is audited for inputs only
      if (r.height < 43.5 || r.width < 43.5) small.push(`${el.tagName} ${el.getAttribute("aria-label") || el.textContent.trim().slice(0, 20)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    });
    const smallInputs = [...document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea")]
      .filter((el) => el.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => el.outerHTML.slice(0, 60));
    return { small, smallInputs, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth };
  });
}

for (const path of PAGES) {
  test(`flag on ${path}: KitShell, bottom bar, no h-scroll, 44px targets`, async ({ page }) => {
    await page.goto(`${path}?hfy_flags=shellV2`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
    await expect(page.locator("nav.navbar-hf")).toBeHidden();
    const bar = page.locator('#hfy-shell-root nav[aria-label]:visible', { hasText: "Posts" });
    await expect(bar.first()).toBeVisible();
    for (const label of ["Home", "Family", "Posts", "Me"]) await expect(page.locator("#hfy-shell-root").getByRole("link", { name: label }).first()).toBeAttached();
    await expect(page.getByRole("button", { name: "Search" })).toBeVisible();
    const a = await audit(page);
    expect(a.small, "targets < 44px").toEqual([]);
    expect(a.smallInputs, "inputs < 16px").toEqual([]);
    expect(a.scrollW).toBeLessThanOrEqual(a.innerW);
  });
}

test("flag off: old navbar, no shell, nothing injected", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(500);
  await expect(page.locator("nav.navbar-hf")).toBeVisible();
  expect(await page.locator("#hfy-shell-root").count()).toBe(0);
  expect(await page.locator('link[rel=manifest]').count()).toBe(0);
});

test("override persists in hfy:flags and empty value clears it", async ({ page }) => {
  await page.goto("/?hfy_flags=shellV2,authV2");
  expect(await page.evaluate(() => localStorage.getItem("hfy:flags"))).toBe("shellV2,authV2");
  await page.goto("/about/");
  await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
  await page.goto("/?hfy_flags=");
  expect(await page.evaluate(() => localStorage.getItem("hfy:flags"))).toBeNull();
  await page.waitForTimeout(400);
  await expect(page.locator("nav.navbar-hf")).toBeVisible();
});

test("AC3: static nav links present without JS", async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:8089/?hfy_flags=shellV2");
  await expect(page.locator('nav.navbar-hf a[href="/about/"]')).toHaveCount(1);
  await ctx.close();
});
