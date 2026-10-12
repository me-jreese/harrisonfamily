// HFY-R58 (sw-clone-after-consume): /sw.js clones before respondWith so hashed island chunks are actually cached, serves
// stable-named entries network-first so a stale cached shell.js can never import deleted chunks, and drops old caches.
// Design-system pass (v3): the self-hosted faces under /fonts/ (content-hashed names) are cache-first; the theme layer
// /css/hfy-theme.css?v=<sha8> is precached and network-first, with an offline fallback to the cached copy of any ?v.
import { test, expect } from "@playwright/test";

const VERSION = "hfy-shell-v3";

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
  return (await c.keys()).map((r) => { const u = new URL(r.url); return u.pathname + u.search; });
}, VERSION);
const themeHref = (page) => page.locator('link[rel="stylesheet"][href^="/css/hfy-theme.css"]').first().getAttribute("href");
const preloadHref = (page) => page.locator('link[rel="preload"][as="font"]').getAttribute("href");

test.beforeEach(async ({ page }) => { await page.route("https://accounts.google.com/**", (r) => r.abort()); });

test("hashed island chunks, the theme and the fonts are cached on first use (no clone-after-consume), old caches are dropped", async ({ page }) => {
  // Seed the old caches from offline.html, which never mounts the shell (the shell registers /sw.js): seeded from /about/, the worker
  // could install and activate (dropping old caches) BEFORE the seed landed, and under load the old caches then survived.
  await page.goto("/offline.html");
  await page.evaluate(async () => {
    for (const old of ["hfy-shell-v1", "hfy-shell-v2"]) { const c = await caches.open(old); await c.put("/js/islands/shell.js", new Response("stale")); }
  });
  await controlled(page);
  const href = await themeHref(page);
  await expect.poll(() => cached(page), { timeout: 10_000 }).toEqual(expect.arrayContaining([
    "/offline.html", "/js/islands/shell.js", expect.stringMatching(/^\/js\/islands\/chunks\/.+\.js$/),
    href, expect.stringMatching(/^\/fonts\/source-sans-3-latin-wght-normal\.[0-9a-f]{8}\.woff2$/)
  ]));
  const keys = await page.evaluate(() => caches.keys());
  expect(keys).not.toContain("hfy-shell-v1");
  expect(keys).not.toContain("hfy-shell-v2");
  // one theme copy only: the newest ?v replaces the precached / older ones
  expect((await cached(page)).filter((k) => k.startsWith("/css/hfy-theme.css"))).toEqual([href]);
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

test("fonts are cache-first: a cached face is served without touching the network", async ({ page }) => {
  await controlled(page);
  const font = await preloadHref(page);
  await expect.poll(() => cached(page), { timeout: 10_000 }).toContain(font);
  let network = 0;
  await page.route(`**${font}`, (r) => { network += 1; return r.continue(); });
  await page.evaluate(async ({ v, font }) => { await (await caches.open(v)).put(font, new Response("cached-face", { headers: { "content-type": "font/woff2" } })); }, { v: VERSION, font });
  const body = await page.evaluate((u) => fetch(u).then((r) => r.text()), font);
  expect(body).toBe("cached-face");
  expect(network).toBe(0);
});

test("the theme is network-first while online and served from the cache (any ?v) when offline", async ({ page, context }) => {
  await controlled(page);
  const href = await themeHref(page);
  await expect.poll(() => cached(page), { timeout: 10_000 }).toContain(href);
  await page.evaluate(async ({ v, href }) => { await (await caches.open(v)).put(href, new Response("/* stale */", { headers: { "content-type": "text/css" } })); }, { v: VERSION, href });
  const online = await page.evaluate((u) => fetch(u).then((r) => r.text()), href);
  expect(online).toContain("--io-color-semantic-surface");
  await expect.poll(() => page.evaluate(async ({ v, href }) => (await (await caches.open(v)).match(href)).text(), { v: VERSION, href })).toContain("--io-color-semantic-surface");
  await context.setOffline(true);
  try {
    const offline = await page.evaluate(() => fetch("/css/hfy-theme.css?v=00000000").then((r) => r.text()));
    expect(offline).toContain("--io-color-semantic-surface");
  } finally {
    await context.setOffline(false);
  }
});
