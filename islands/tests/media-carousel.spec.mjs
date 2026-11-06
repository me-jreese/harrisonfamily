// HFY-TSK-388-0C: the posts-page media carousel (island media-carousel, flag mediaBrowserV1) at 375x667 and 1280x800. Synthetic data only; /auth/session, /api/me,
// /api/posts, /api/media and the flags file are stubbed with the real reply shapes (docs/reference/api.md). At most two screenshots, attached to the report.
// Run: HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/media-carousel.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { DEFAULT_LABELS as L } from "@io-kit/media/browser";
import { axeViolations } from "./axe.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PHONE = { width: 375, height: 667 };
const DESKTOP = { width: 1280, height: 800 };
const ULID = (n) => `01JZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(3, "0")}`;
const T0 = "2026-01-01T00:00:00.000Z";
const card = (id, over = {}) => ({ mediaId: id, thumbUrl: `/t/${id}-320.png`, width: 320, height: 240, section: "media", tagCount: 1, needsTags: false, title: `Photo ${id}`, year: 1952, grampsId: id, addedAt: 100, thumb: { s320: `/t/${id}-320.png`, s800: `/t/${id}-800.png`, w: 320, h: 240 }, ...over });
const cards = (n = 14) => Array.from({ length: n }, (_, i) => card(`M${String(i + 1).padStart(4, "0")}`, i === 1 ? { needsTags: true, tagCount: 0 } : i === 2 ? { thumb: undefined, thumbUrl: "", title: "No thumb" } : i % 2 ? { section: "posts" } : {}));
const post = (n) => ({ id: ULID(n), type: "post", author: { id: "I9003", label: "Ann Other" }, subject: "I9003", body: `Feed post number ${n}. `.repeat(40), attachments: [], visibility: "published", created_at: T0, updated_at: T0, can: { edit: false, delete: false, publish: false } });

async function open(page, { flag = true, session = "I9001", list = null, reduced = false } = {}) {
  const s = { lists: [], images: [], islandRequests: [] };
  if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: true, searchV2: false, notifyV2: false, navMe: false, mediaBrowserV1: flag } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: session ? { authenticated: true, sub: session, grampsId: session, label: "Sam Example" } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/api/me", (r) => r.fulfill({ status: session ? 200 : 401, json: session ? { id: session, label: "Sam Example", admin: false, can: {} } : { error: "unauthenticated" } }));
  await page.route(/\/js\/islands\/media-carousel\./, (r) => { s.islandRequests.push(r.request().url()); return r.continue(); });
  await page.route(/\/t\/.*\.png/, (r) => { s.images.push(new URL(r.request().url()).pathname); return r.fulfill({ body: PNG, contentType: "image/png" }); });
  await page.route(/\/api\/posts(\/[^/?]+)?(\?.*)?$/, (r) => r.fulfill({ json: { items: Array.from({ length: 12 }, (_, i) => post(12 - i)), cursor: null } }));
  await page.route("**/api/comments**", (r) => r.fulfill({ json: { thread: { id: "x", topic: "comments", comments: [], reactions: {} } } }));
  await page.route(/\/api\/media(\?[^/]*)?$/, (r) => {
    const u = new URL(r.request().url());
    s.lists.push(Object.fromEntries(u.searchParams));
    const body = typeof list === "function" ? list() : list ?? { cards: cards(), nextCursor: null, counts: { media: 7, posts: 7 } };
    return r.fulfill(body.__status ? { status: body.__status, json: { error: "x" } } : { json: body });
  });
  await page.goto("/posts/", { waitUntil: "domcontentloaded" });
  return s;
}
// HFY-TSK-404: WCAG contrast of two computed "rgb(...)"/"rgba(...)" colours, so the header link is proven readable and not merely present.
const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
async function headerLink(page) {
  const link = page.locator(".io-media-band-head .io-media-link");
  await expect(link).toBeVisible();
  await expect(link).toHaveText(L.allMedia);
  await expect(link).toHaveAttribute("href", "/all-media/");
  return page.evaluate(() => {
    const a = document.querySelector(".io-media-band-head .io-media-link"), t = document.querySelector(".io-media-band-title");
    const b = a.getBoundingClientRect(), c = document.querySelector(".io-media-band-clip").getBoundingClientRect(), tr = t.getBoundingClientRect();
    let el = a, bg = "rgb(255, 255, 255)";
    while (el) { const v = getComputedStyle(el).backgroundColor; if (v && !/rgba\(0, 0, 0, 0\)|transparent/.test(v)) { bg = v; break; } el = el.parentElement; }
    return { w: b.width, h: b.height, left: b.left, right: b.right, clipLeft: c.left, clipRight: c.right, titleRight: tr.right, vw: document.documentElement.clientWidth, color: getComputedStyle(a).color, bg };
  });
}
const expectHeaderLinkVisible = async (page) => {
  const m = await headerLink(page);
  expect(m.w).toBeGreaterThan(0);
  expect(m.h).toBeGreaterThanOrEqual(44);
  expect(m.left).toBeGreaterThanOrEqual(m.titleRight);
  expect(m.left).toBeGreaterThanOrEqual(m.clipLeft);
  expect(m.right).toBeLessThanOrEqual(m.clipRight + 0.5);
  expect(m.right).toBeLessThanOrEqual(m.vw);
  expect(m.color).not.toBe(m.bg);
  expect(contrast(m.color, m.bg)).toBeGreaterThanOrEqual(4.5);
};
const band = (page) => page.locator("section.io-media-carousel");
const firstPost = (page) => page.getByText("Feed post number 12.").first();
const noSideways = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
const scrollTo = (page, y) => page.evaluate((top) => window.scrollTo(0, top), y);

test.describe("phone 375x667", () => {
  test.use({ viewport: PHONE });

  test("at most half the viewport, the first post visible on load, newest first across both sections, s320 only, badge, placeholder, axe", async ({ page }, testInfo) => {
    const s = await open(page);
    await expect(band(page)).toBeVisible();
    await expect(page.getByRole("link", { name: /Photo M0001/ })).toBeVisible();
    await expect(firstPost(page)).toBeVisible();
    expect(s.lists[0]).toMatchObject({ section: "all", filter: "all" });
    const m = await page.evaluate(() => {
      const h = document.querySelector("section.io-media-carousel").getBoundingClientRect().height;
      const p = [...document.querySelectorAll("article, li, section")].find((n) => n.textContent.includes("Feed post number 12.") && !n.closest(".io-media"));
      return { h, vh: window.innerHeight, postTop: p.getBoundingClientRect().top };
    });
    expect(m.h).toBeLessThanOrEqual(m.vh / 2);
    expect(m.postTop).toBeLessThan(m.vh - 40);
    await expect(page.locator(".io-media-badge").first()).toHaveText(L.needsTags);
    await expect(page.locator('a[aria-label*="needs tags"]')).toHaveCount(1);
    await expect(page.locator(".io-media-missing")).toHaveCount(1);
    await page.waitForTimeout(300);
    expect(s.images.length).toBeGreaterThan(0);
    expect(s.images.every((p) => /-320\.png$/.test(p))).toBe(true);
    await noSideways(page);
    expect(await axeViolations(page)).toEqual([]);
    await testInfo.attach("posts-375", { body: await page.screenshot(), contentType: "image/png" });
  });

  for (const scheme of ["dark", "light"]) {
    test(`the "all media" link shows on the right of the header row above the strip (${scheme} scheme)`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      await expect(band(page)).toBeVisible();
      await expectHeaderLinkVisible(page);
      await noSideways(page);
    });
  }

  test("scrolling into the feed collapses the band, the top restores it", async ({ page }) => {
    await open(page);
    await expect(band(page)).toHaveAttribute("data-phase", "expanded");
    await scrollTo(page, 900);
    await expect(band(page)).toHaveAttribute("data-phase", "collapsed");
    await expect(page.getByText(L.collapsedNote)).toBeVisible();
    await scrollTo(page, 0);
    await expect(band(page)).toHaveAttribute("data-phase", "expanded");
    await expect(page.getByRole("link", { name: /Photo M0001/ })).toBeVisible();
  });

  test("reduced motion: the band collapses and returns at once, with no transition", async ({ page }) => {
    await open(page, { reduced: true });
    await expect(band(page)).toHaveAttribute("data-phase", "expanded");
    expect(await page.locator(".io-media-band").evaluate((n) => getComputedStyle(n).transitionDuration)).toMatch(/^0s(, 0s)*$/);
    await scrollTo(page, 900);
    await expect(band(page)).toHaveAttribute("data-phase", "collapsed");
    await expect(page.locator(".io-media-band")).toHaveCSS("opacity", "0");
    await scrollTo(page, 0);
    await expect(band(page)).toHaveAttribute("data-phase", "expanded");
  });

  test("focus inside the band keeps it open while the feed scrolls", async ({ page }) => {
    await open(page);
    await page.getByRole("link", { name: /Photo M0001/ }).focus();
    await scrollTo(page, 900);
    await page.waitForTimeout(250);
    await expect(band(page)).toHaveAttribute("data-phase", "expanded");
    await expect(page.getByRole("link", { name: /Photo M0001/ })).toBeFocused();
  });

  test("both 'all media' links go to /all-media/ and a card to its detail there; the menu does not carry it", async ({ page }) => {
    await open(page);
    const all = page.getByRole("link", { name: L.allMedia });
    await expect(all).toHaveCount(2);
    for (const a of await all.all()) await expect(a).toHaveAttribute("href", "/all-media/");
    await expect(page.getByRole("link", { name: /Photo M0001/ })).toHaveAttribute("href", "/all-media/?id=M0001");
    await expect(page.locator("nav a[href^='/all-media'], nav a[href^='/media/']")).toHaveCount(0);
  });

  test("a failed read removes the band and leaves the feed", async ({ page }) => {
    await open(page, { list: { __status: 503 } });
    await expect(firstPost(page)).toBeVisible();
    await expect(page.locator("[data-hfy-mc]")).toHaveCount(0);
    await expect(band(page)).toHaveCount(0);
  });

  test("flag off: the bundle is not requested, no photos are read, the feed stands", async ({ page }) => {
    const s = await open(page, { flag: false });
    await expect(firstPost(page)).toBeVisible();
    await page.waitForTimeout(400);
    expect(s.islandRequests).toEqual([]);
    expect(s.lists).toEqual([]);
    await expect(page.locator("#hfy-media-carousel")).toHaveCount(0);
  });

  test("signed out: nothing is drawn and no photos are read", async ({ page }) => {
    const s = await open(page, { session: null });
    await page.waitForTimeout(600);
    expect(s.lists).toEqual([]);
    await expect(band(page)).toHaveCount(0);
  });
});

test.describe("desktop 1280", () => {
  test.use({ viewport: DESKTOP });

  test("the \"all media\" link shows on the right of the header row", async ({ page }) => {
    await open(page);
    await expect(band(page)).toBeVisible();
    await expectHeaderLinkVisible(page);
  });

  test("a 280 px band, 44 px scroll buttons that work from the keyboard, axe, no sideways scroll", async ({ page }, testInfo) => {
    await open(page);
    await expect(page.getByRole("link", { name: /Photo M0001/ })).toBeVisible();
    const m = await page.evaluate(() => {
      const b = document.querySelector(".io-media-band").getBoundingClientRect().height;
      const btn = [...document.querySelectorAll(".io-media-scroll-btn")].map((n) => n.getBoundingClientRect()).map((r) => ({ w: r.width, h: r.height }));
      return { b, btn };
    });
    expect(m.b).toBeLessThanOrEqual(280);
    expect(m.b).toBeGreaterThan(200);
    expect(m.btn).toHaveLength(2);
    for (const r of m.btn) { expect(r.w).toBeGreaterThanOrEqual(44); expect(r.h).toBeGreaterThanOrEqual(44); }
    const strip = page.locator("ul.io-media-strip");
    expect(await strip.evaluate((n) => n.scrollLeft)).toBe(0);
    await page.getByRole("button", { name: L.scrollForward }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => strip.evaluate((n) => n.scrollLeft)).toBeGreaterThan(0);
    await page.getByRole("button", { name: L.scrollBack }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => strip.evaluate((n) => n.scrollLeft)).toBe(0);
    await noSideways(page);
    expect(await axeViolations(page)).toEqual([]);
    await testInfo.attach("posts-1280", { body: await page.screenshot(), contentType: "image/png" });
  });
});
