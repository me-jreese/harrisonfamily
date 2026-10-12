// HFY-TSK-068: /me/notifications with notifyV2 at 375px; /api stubbed (preferences kept in memory).
import { test, expect } from "@playwright/test";

async function stub(page) {
  const state = { enabled: true, types: {}, extra: {} };
  await page.route("**/api/notifications/**", async (r) => {
    const req = r.request(); const u = new URL(req.url());
    if (u.pathname.endsWith("/vapid-public-key")) return r.fulfill({ json: { public_key: "AAAA" } });
    if (u.pathname.endsWith("/preferences")) {
      if (req.method() === "PUT") { Object.assign(state, req.postDataJSON()); return r.fulfill({ json: state }); }
      return r.fulfill({ json: state });
    }
    return r.fulfill({ json: {} });
  });
  return state;
}

test("flag on: settings render, a toggle persists via /api, 375px clean", async ({ page }) => {
  const state = await stub(page);
  await page.goto("/me/notifications/?hfy_flags=notifyV2", { waitUntil: "domcontentloaded" });
  const root = page.locator(".hfy-notify");
  await expect(root).toBeVisible();
  await expect(root.getByText("Comments on my record", { exact: true })).toBeVisible();
  await expect(root.getByText("Mentions", { exact: true })).toBeVisible();
  await expect(page.locator("[data-notify-off]")).toHaveCount(0);
  const first = root.locator('[data-type="mention"] [role=switch]');
  await first.click();
  await expect.poll(() => Object.keys(state.types).length).toBeGreaterThan(0);
  await page.reload();
  await expect(root.getByText("Comments on my record", { exact: true })).toBeVisible();
  expect(Object.values(state.types).some((t) => t.enabled === false)).toBe(true);
  const a = await page.evaluate(() => {
    const r = document.querySelector(".hfy-notify");
    const small = [];
    r.querySelectorAll("a[href], button, select, [role=switch], label").forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) return;
      if (b.height < 43.5) small.push(`${el.tagName} ${(el.textContent || "").trim().slice(0, 20)} ${Math.round(b.width)}x${Math.round(b.height)}`);
    });
    const smallInputs = [...r.querySelectorAll("input:not([type=checkbox]):not([type=radio]), select, textarea")].filter((el) => el.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(el).fontSize) < 16).length;
    return { small, smallInputs, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth };
  });
  expect(a.small, "targets < 44px").toEqual([]);
  expect(a.smallInputs).toBe(0);
  expect(a.scrollW).toBeLessThanOrEqual(a.innerW);
});

test("flag off: page says not enabled, no island", async ({ page }) => {
  await page.goto("/me/notifications/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-notify-off]")).toBeVisible();
  expect(await page.locator(".hfy-notify").count()).toBe(0);
});

test("HFY-R48: searchV2 implies shellV2 (and -shellV2 wins)", async ({ page }) => {
  await page.goto("/about/?hfy_flags=searchV2");
  await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
  await page.goto("/about/?hfy_flags=searchV2,-shellV2");
  await page.waitForTimeout(500);
  expect(await page.locator("#hfy-shell-root").count()).toBe(0);
});

test("notify-sw is built and /sw.js hook points at it", async ({ request }) => {
  expect((await request.get("/js/islands/notify-sw.js")).ok()).toBe(true);
  expect(await (await request.get("/sw.js")).text()).toContain("/js/islands/notify-sw.js");
});
