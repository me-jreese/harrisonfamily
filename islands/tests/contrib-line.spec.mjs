// HFY-TSK-190 at 375px: the feed line (contribV1) on the homepage timeline and /posts/. /api and /auth/session are stubbed; synthetic data only.
import { test, expect } from "@playwright/test";

const T0 = "2026-01-01T00:00:00.000Z";
const POST = { id: "01JZZZZZZZZZZZZZZZZZZZZ001", type: "post", author: { id: "I9003", label: "Ann Other" }, subject: "I9003", body: "Seeded older post", attachments: [], visibility: "published", created_at: T0, updated_at: T0, can: { edit: false, delete: false, publish: false } };

async function stub(page, { signedIn = true, items = [POST], stats = { total: 9, line: { x: 9, y: 2, unit: "month", window_days: 60, text: "9 contributions in the past 2 months" }, computed_at: T0 }, statsStatus = 200 } = {}) {
  const asked = { stats: 0 };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/auth/session", (r) => r.fulfill({ json: signedIn ? { authenticated: true, sub: "I9001", grampsId: "I9001", label: "Test Person" } : { authenticated: false } }));
  await page.route(/\/api\/posts(\/[^/?]+)?(\?.*)?$/, (r) => (signedIn ? r.fulfill({ json: { items, cursor: null } }) : r.fulfill({ status: 401, json: { error: "unauthenticated" } })));
  await page.route("**/api/contributions/stats**", (r) => { asked.stats += 1; return r.fulfill({ status: statsStatus, json: statsStatus === 200 ? stats : { error: "not_found" } }); });
  return asked;
}
const line = (page) => page.locator("p.hfy-contrib-line");

for (const [name, path, scope] of [["home timeline", "/", "[data-hfy-timeline]"], ["/posts/", "/posts/", "[data-hfy-posts]"]]) {
  test(`${name}: contribV1 on shows the server's line under the heading`, async ({ page }) => {
    await stub(page);
    await page.goto(`${path}?hfy_flags=postsV2,shellV2,contribV1`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(scope).getByText("Seeded older post")).toBeVisible();
    await expect(line(page)).toHaveText("9 contributions in the past 2 months");
    await expect(line(page)).toHaveCount(1);
    expect(await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector("p.hfy-contrib-line")).fontSize))).toBeGreaterThanOrEqual(16);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test(`${name}: a null line shows the fallback copy`, async ({ page }) => {
    await stub(page, { stats: { total: 1, line: null, computed_at: T0 } });
    await page.goto(`${path}?hfy_flags=postsV2,shellV2,contribV1`, { waitUntil: "domcontentloaded" });
    await expect(line(page)).toHaveText("add a photo or a story to get things going.");
  });

  test(`${name}: grammar, one contribution in the past week`, async ({ page }) => {
    await stub(page, { stats: { total: 1, line: { x: 1, y: 1, unit: "week", window_days: 7, text: "x" }, computed_at: T0 } });
    await page.goto(`${path}?hfy_flags=postsV2,shellV2,contribV1`, { waitUntil: "domcontentloaded" });
    await expect(line(page)).toHaveText("1 contribution in the past week");
  });

  test(`${name}: an empty feed still shows the line, once`, async ({ page }) => {
    await stub(page, { items: [] });
    await page.goto(`${path}?hfy_flags=postsV2,shellV2,contribV1`, { waitUntil: "domcontentloaded" });
    await expect(line(page)).toHaveText("9 contributions in the past 2 months");
    await expect(line(page)).toHaveCount(1);
  });

  test(`${name}: signed out renders no line and asks for no stats`, async ({ page }) => {
    const asked = await stub(page, { signedIn: false });
    const session = page.waitForResponse("**/auth/session");
    await page.goto(`${path}?hfy_flags=postsV2,shellV2,contribV1`, { waitUntil: "domcontentloaded" });
    await session;
    await page.waitForLoadState("networkidle");
    await expect(line(page)).toHaveCount(0);
    expect(asked.stats).toBe(0);
  });

  test(`${name}: contribV1 off (the shipped default) asks for nothing and shows no line`, async ({ page }) => {
    const asked = await stub(page);
    await page.goto(`${path}?hfy_flags=postsV2,shellV2,-contribV1`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(scope).getByText("Seeded older post")).toBeVisible();
    await expect(line(page)).toHaveCount(0);
    expect(asked.stats).toBe(0);
  });

  test(`${name}: a dark or failing stats route draws no line`, async ({ page }) => {
    await stub(page, { statsStatus: 404 });
    await page.goto(`${path}?hfy_flags=postsV2,shellV2,contribV1`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(scope).getByText("Seeded older post")).toBeVisible();
    await expect(line(page)).toHaveCount(0);
  });
}
