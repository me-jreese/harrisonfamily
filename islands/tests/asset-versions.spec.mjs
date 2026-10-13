// HFY asset versioning (islands/assets.mjs): Cloudflare caches static files (js, css, fonts, sw.js) for 4 h under the URL they were
// fetched at and CloudFront invalidations never reach it, so after a deploy visitors got old and new files mixed. Every script,
// stylesheet, island entry, manifest and the worker registration therefore carries ?v=<sha8 of the file>, driven from the uncached
// HTML. These tests play the stale edge: the bare (unversioned) URLs of the files that changed are answered with old content, and
// the page must not depend on any of them.
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SITE = resolve(process.env.HFY_SITE || "../11ty");
const sha8 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 8);
const onDisk = (path) => sha8(readFileSync(resolve(SITE, path.replace(/^\//, ""))));
const WIDTHS = [375, 688, 1024];
const PAGES = ["/", "/about/", "/search/", "/contact/", "/posts/", "/me/notifications/"];

async function hermetic(page) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/api/**", (r) => r.fulfill({ status: 401, json: { error: "unauthenticated" } }));
}

// The Cloudflare edge after a deploy: the bare URLs still answer with the previous deploy's bytes (glob = the whole URL, so a
// ?v= request never matches). The stale shell.js would render the old sidebar, the stale sw.js would keep the old cache name.
async function staleEdge(page, served) {
  const stale = (kind) => (r) => {
    served.push(r.request().url());
    return r.fulfill(kind === "css" ? { contentType: "text/css", body: "/* STALE EDGE */ body{background:#f0f}" } : { contentType: "text/javascript", body: "throw new Error('STALE EDGE')" });
  };
  for (const p of ["js/islands/shell.js", "js/islands/search.js", "js/islands/timeline.js", "js/islands/posts.js", "js/islands/notifications.js", "js/feature-flags.js", "js/auth.js", "js/search-navbar.js", "sw.js"]) await page.route(`**/${p}`, stale("js"));
  for (const p of ["js/islands/shell.css", "js/islands/search.css", "js/islands/timeline.css", "js/islands/posts.css", "js/islands/notifications.css", "css/main.css", "css/hfy-theme.css"]) await page.route(`**/${p}`, stale("css"));
}

const bare = (urls) => urls.filter((u) => { const p = new URL(u); return /^\/(js|css)\/.+\.(js|css)$/.test(p.pathname) && !p.pathname.startsWith("/js/islands/chunks/") && !p.searchParams.has("v"); });

for (const path of PAGES) {
  test(`${path}: every same-origin script / stylesheet / manifest request carries ?v=<sha8 of the served file>, and the bare stale URLs are never requested`, async ({ page }) => {
    await hermetic(page);
    const served = [];
    await staleEdge(page, served);
    const requested = [];
    page.on("request", (q) => { if (new URL(q.url()).hostname === "127.0.0.1") requested.push(q.url()); });
    await page.goto(`${path}?hfy_flags=shellV2,searchV2,notifyV2,postsV2`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(served, "no request reached a bare (stale-able) URL").toEqual([]);
    expect(bare(requested)).toEqual([]);
    const assets = requested.filter((u) => /\.(js|css|webmanifest)(\?|$)/.test(new URL(u).pathname + new URL(u).search) && !new URL(u).pathname.startsWith("/js/islands/chunks/"));
    expect(assets.length).toBeGreaterThan(3);
    for (const u of assets) {
      const url = new URL(u);
      const v = url.searchParams.get("v");
      expect(v, `${u} is versioned`).toMatch(/^[0-9a-f]{8}$/);
      expect(v, `${u}: ?v is the sha256 of the file`).toBe(onDisk(url.pathname));
    }
    // the loader's runtime references (the island entry and its stylesheet) and the static ones are all among them
    expect(assets.map((u) => new URL(u).pathname)).toEqual(expect.arrayContaining(["/js/islands/shell.js", "/js/islands/shell.css", "/js/feature-flags.js", "/css/hfy-theme.css"]));
  });
}

test("the service worker is registered at /sw.js?v=<sha8 of sw.js> even while the bare /sw.js is stale at the edge", async ({ page }) => {
  await hermetic(page);
  const served = [];
  await staleEdge(page, served);
  await page.goto("/about/?hfy_flags=shellV2");
  await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
  const reg = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return (r.active || r.waiting || r.installing).scriptURL; });
  const url = new URL(reg);
  expect(url.pathname).toBe("/sw.js");
  expect(url.searchParams.get("v")).toBe(onDisk("/sw.js"));
  await expect.poll(() => page.evaluate(() => caches.keys())).toEqual([`hfy-shell-${onDisk("/sw.js")}`]);
  expect(served.filter((u) => new URL(u).pathname === "/sw.js")).toEqual([]);
});

for (const width of WIDTHS) {
  test(`${width}: with every bare URL stale, the shell is the new top bar (brand, no sidebar, no unicode icons), not the old sidebar`, async ({ page }) => {
    await hermetic(page);
    await staleEdge(page, []);
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/about/?hfy_flags=shellV2");
    const shell = page.locator("#hfy-shell-root .io-shell");
    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute("data-bp", width >= 1024 ? "expanded" : width >= 688 ? "medium" : "compact");
    const bar = page.locator("#hfy-shell-root .hfy-bar");
    await expect(bar).toBeVisible();
    await expect(bar.locator(".hfy-bar__brand")).toBeVisible();
    if (width >= 688) {
      await expect(page.locator("#hfy-shell-root .hfy-bar__links a")).toHaveCount(5);
      await expect(page.locator("#hfy-shell-root nav.io-shell__bar")).toHaveCount(0);
    } else {
      await expect(page.locator("#hfy-shell-root nav.io-shell__bar .io-nav__item--bar")).toHaveCount(5);
    }
    // no sidebar / rail painted at any width: the kit renders it hidden (0 x 0) or not at all
    const rail = await page.evaluate(() => {
      const el = document.querySelector("#hfy-shell-root .io-shell__rail, #hfy-shell-root .io-shell__sidebar");
      if (!el) return "none";
      const r = el.getBoundingClientRect();
      return `${r.width}x${r.height}`;
    });
    expect(["none", "0x0"]).toContain(rail);
    // the new shell leaves the icon slot to the theme (a blank glyph); the old one printed unicode symbols in it
    const icons = await page.evaluate(() => [...document.querySelectorAll("#hfy-shell-root .io-nav__icon")].map((e) => e.textContent.trim()));
    expect(icons.length).toBeGreaterThan(0);
    expect(icons.filter(Boolean), "unicode icon glyphs from the old shell").toEqual([]);
    // and the theme is the new one, not the stale stylesheet that was waiting at the bare URL
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgb(255, 0, 255)");
  });
}
