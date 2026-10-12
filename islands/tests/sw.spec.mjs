// HFY-R58 (sw-clone-after-consume): /sw.js clones before respondWith so hashed island chunks are actually cached, serves
// stable-named entries network-first so a stale cached shell.js can never import deleted chunks, and drops old caches.
// Design-system pass (v3): the self-hosted faces under /fonts/ (content-hashed names) are cache-first; the theme layer
// /css/hfy-theme.css?v=<sha8> is precached and network-first, with an offline fallback to the cached copy of any ?v.
// Asset versioning: the worker is registered at /sw.js?v=<sha8 of sw.js> and names its cache hfy-shell-<that sha8>; every URL it
// precaches or caches is the versioned one the page requested (Cloudflare caches static files for 4 h under the URL fetched),
// a new deploy replaces the cached copy of a path instead of adding to it, and the previous worker's cache is dropped.
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SITE = resolve(process.env.HFY_SITE || "../11ty");
const SW_HASH = createHash("sha256").update(readFileSync(resolve(SITE, "sw.js"))).digest("hex").slice(0, 8);
const VERSION = `hfy-shell-${SW_HASH}`;
const SHELL = /^\/js\/islands\/shell\.js\?v=[0-9a-f]{8}$/;

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
// The shell entry the page actually requested (versioned): shell.js?v=<sha8 of shell.js>.
const shellKey = async (page) => (await cached(page)).find((k) => SHELL.test(k));

test.beforeEach(async ({ page }) => { await page.route("https://accounts.google.com/**", (r) => r.abort()); });

test("the worker is registered at /sw.js?v=<sha8 of sw.js>, which is also its cache name", async ({ page }) => {
  await controlled(page);
  const reg = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).active.scriptURL);
  expect(new URL(reg).pathname + new URL(reg).search).toBe(`/sw.js?v=${SW_HASH}`);
  expect(await page.evaluate(() => window.HFYFeatureFlags.assetVersions.sw)).toBe(SW_HASH);
  await expect.poll(() => page.evaluate(() => caches.keys())).toEqual([VERSION]);
});

test("hashed island chunks, the theme and the fonts are cached on first use (no clone-after-consume), old caches are dropped", async ({ page }) => {
  // Seed the old caches from offline.html, which never mounts the shell (the shell registers /sw.js): seeded from /about/, the worker
  // could install and activate (dropping old caches) BEFORE the seed landed, and under load the old caches then survived.
  // hfy-shell-v3 is the cache the pre-versioning worker used (an unversioned /js/islands/shell.js that Cloudflare may have held for 4 h).
  await page.goto("/offline.html");
  await page.evaluate(async () => {
    for (const old of ["hfy-shell-v1", "hfy-shell-v2", "hfy-shell-v3", "hfy-shell-00000000"]) { const c = await caches.open(old); await c.put("/js/islands/shell.js", new Response("stale")); }
  });
  await controlled(page);
  const href = await themeHref(page);
  await expect.poll(() => cached(page), { timeout: 10_000 }).toEqual(expect.arrayContaining([
    "/offline.html", expect.stringMatching(SHELL), expect.stringMatching(/^\/js\/islands\/shell\.css\?v=[0-9a-f]{8}$/),
    expect.stringMatching(/^\/js\/islands\/chunks\/.+\.js$/), href, expect.stringMatching(/^\/manifest\.webmanifest\?v=[0-9a-f]{8}$/),
    expect.stringMatching(/^\/fonts\/source-sans-3-latin-wght-normal\.[0-9a-f]{8}\.woff2$/)
  ]));
  expect(await page.evaluate(() => caches.keys())).toEqual([VERSION]);
  // the unversioned names the previous worker precached are never stored again
  const keys = await cached(page);
  expect(keys).not.toContain("/js/islands/shell.js");
  expect(keys).not.toContain("/js/islands/shell.css");
  expect(keys).not.toContain("/css/hfy-theme.css");
  // one theme copy only: the newest ?v replaces the precached / older ones
  expect(keys.filter((k) => k.startsWith("/css/hfy-theme.css"))).toEqual([href]);
});

test("a stale cached shell.js (pointing at a deleted chunk) is not served while the network is up", async ({ page }) => {
  await controlled(page);
  await expect.poll(() => shellKey(page), { timeout: 10_000 }).toBeTruthy();
  const key = await shellKey(page);
  await page.evaluate(async ({ v, key }) => {
    const c = await caches.open(v);
    await c.put(key, new Response('import "/js/islands/chunks/chunk-DELETED0.js";', { headers: { "content-type": "text/javascript" } }));
  }, { v: VERSION, key });
  await page.reload();
  await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.classList.contains("hfy-shell-v2"))).toBe(true);
  // network-first refreshed the cached entry with the real module
  const body = await page.evaluate(async ({ v, key }) => (await (await caches.open(v)).match(key)).text(), { v: VERSION, key });
  expect(body).not.toContain("chunk-DELETED0");
});

test("a deploy replaces the cached copy of an island entry instead of adding to it; offline serves the newest copy of the path", async ({ page, context }) => {
  await controlled(page);
  await expect.poll(() => shellKey(page), { timeout: 10_000 }).toBeTruthy();
  const key = await shellKey(page);
  // what the previous deploy left behind: the same path under another ?v
  await page.evaluate(async ({ v }) => { await (await caches.open(v)).put("/js/islands/shell.js?v=00000000", new Response("/* previous deploy */", { headers: { "content-type": "text/javascript" } })); }, { v: VERSION });
  await page.reload();
  await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
  await expect.poll(async () => (await cached(page)).filter((k) => k.startsWith("/js/islands/shell.js"))).toEqual([key]);
  await context.setOffline(true);
  try {
    const offline = await page.evaluate(() => fetch("/js/islands/shell.js?v=11111111").then((r) => r.text()));
    expect(offline).toContain("hfy-shell-root");
  } finally {
    await context.setOffline(false);
  }
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
