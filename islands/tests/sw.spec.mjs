// HFY-R58 (sw-clone-after-consume): /sw.js clones before respondWith so hashed island chunks are actually cached, serves
// stable-named entries network-first so a stale cached shell.js can never import deleted chunks, and drops old caches.
import { test, expect } from "@playwright/test";

const VERSION = "hfy-shell-v2";

async function controlled(page) {
  await page.goto("/about/?hfy_flags=shellV2");
  await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
}

const cached = (page) => page.evaluate(async (v) => {
  const c = await caches.open(v);
  return (await c.keys()).map((r) => new URL(r.url).pathname);
}, VERSION);

test.beforeEach(async ({ page }) => { await page.route("https://accounts.google.com/**", (r) => r.abort()); });

test("hashed island chunks are cached on first use (no clone-after-consume), old caches are dropped", async ({ page }) => {
  await page.goto("/about/");
  await page.evaluate(async () => { const c = await caches.open("hfy-shell-v1"); await c.put("/js/islands/shell.js", new Response("stale")); });
  await controlled(page);
  await expect.poll(() => cached(page), { timeout: 10_000 }).toEqual(expect.arrayContaining([
    "/offline.html", "/js/islands/shell.js", expect.stringMatching(/^\/js\/islands\/chunks\/.+\.js$/)
  ]));
  expect(await page.evaluate(() => caches.keys())).not.toContain("hfy-shell-v1");
});

test("a stale cached shell.js (pointing at a deleted chunk) is not served while the network is up", async ({ page }) => {
  await controlled(page);
  await page.evaluate(async (v) => {
    const c = await caches.open(v);
    await c.put("/js/islands/shell.js", new Response('import "/js/islands/chunks/chunk-DELETED0.js";', { headers: { "content-type": "text/javascript" } }));
  }, VERSION);
  await page.reload();
  await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.classList.contains("hfy-shell-v2"))).toBe(true);
  // network-first refreshed the cached entry with the real module
  const body = await page.evaluate(async (v) => (await (await caches.open(v)).match("/js/islands/shell.js")).text(), VERSION);
  expect(body).not.toContain("chunk-DELETED0");
});
