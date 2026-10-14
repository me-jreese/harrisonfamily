// HFY-TSK-301 (viz-mvp-visual-fallback): the /tree/ fallbacks. Hermetic, like tree.spec.mjs: /_data/flags.json, /auth/*, /person/graph.json
// and /media/faces/* are route-stubbed with the synthetic tests/fixtures/tree-graph-messy.json (invented names).
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/tree-fallback.spec.mjs
//
//   - outline-only mode when the chart chunk is aborted or customElements.define throws (CHART_CHUNK_FAILED)
//   - the cards | outline toggle at 375, 768 and 1280; ?view=outline and localStorage["hfy:tree-view"]; a localStorage that throws; the noscript line
//   - the viz.md section 7 states (401, 403 and 404, bad schema) with the cards view on
//   - a face that fails to load becomes initials with no layout shift
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const MESSY = readFileSync(new URL("./fixtures/tree-graph-messy.json", import.meta.url), "utf8");
const PIXEL = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const FACE_OK = (r) => r.fulfill({ status: 200, contentType: "image/webp", body: PIXEL });
const STORE_KEY = "hfy:tree-view";

async function stub(page, { graph = { status: 200, body: MESSY }, sub = "I8001", refreshOk = true, faces = FACE_OK } = {}) {
  const seen = { graph: 0, refresh: 0, chunk: 0 };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, familyViz: true } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub, label: "Robin Quill" } }));
  await page.route("**/auth/refresh", (r) => { seen.refresh += 1; return r.fulfill({ status: refreshOk ? 200 : 401, json: {} }); });
  await page.route("**/auth/login**", (r) => r.fulfill({ contentType: "text/html", body: "<title>sign in</title><p>sign-in page</p>" }));
  await page.route("**/person/graph.json", (r) => {
    seen.graph += 1;
    const g = typeof graph === "function" ? graph(seen.graph) : graph;
    return r.fulfill({ status: g.status, contentType: "application/json", body: g.body ?? "{}" });
  });
  await page.route("**/media/faces/**", faces);
  await page.route("**/js/islands/chunks/tree-chart-*.js", (r) => { seen.chunk += 1; return r.continue(); });
  return seen;
}

const nav = (page) => page.locator("family-navigator");
const focusName = (page) => page.locator("[data-tree-focus] h2");
const outline = (page) => page.locator("[data-tree-outline]");
const toggle = (page, v) => page.locator(`[data-tree-view='${v}']`);
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

// ---- 1. outline-only mode (CHART_CHUNK_FAILED) ----

const MESSAGE = "the chart didn't load. the outline below has everything.";

/** The outline-only page is complete without the chunk: the notice, no cards and no toggle, the focus navigator and every generation. */
async function expectOutlineOnly(page, errors) {
  await expect(page.locator("[data-tree-chart-failed]")).toHaveText(MESSAGE);
  await expect(page.locator("[data-tree-chart-failed]")).toHaveAttribute("role", "status");
  await expect(nav(page)).toHaveCount(0);
  await expect(page.locator("[data-tree-views]")).toHaveCount(0);
  await expect(focusName(page)).toHaveText("Robin Quill");
  await expect(outline(page)).toBeVisible();
  // the whole tree is there: every person of the graph is reachable in the outline (the unfolded lists plus "show N more" are the same people)
  const total = JSON.parse(MESSY).people.length;
  const counted = await outline(page).locator("summary").evaluateAll((els) => els.reduce((n, e) => n + Number((e.textContent.match(/\((\d+)\)/) || [0, 0])[1]), 0));
  expect(counted).toBe(total);
  // and it still works: a person in the focus navigator re-centres, with history
  await page.locator("[data-tree-focus] button[data-person='I8002']").click();
  await expect(focusName(page)).toHaveText("Sam Quill");
  await expect(page).toHaveURL(/focus=I8002/);
  await expect.poll(() => errors.some((e) => e.includes("CHART_CHUNK_FAILED"))).toBe(true);
}

test("the chart chunk route is aborted: outline-only mode says so, and the outline is complete", async ({ page }) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await stub(page);
  await page.route("**/js/islands/chunks/tree-chart-*.js", (r) => r.abort());
  await page.goto("/tree/?focus=I8001", { waitUntil: "domcontentloaded" });
  await expectOutlineOnly(page, errors);
});

test("customElements.define throws for <family-navigator>: the same outline-only mode", async ({ page }) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.addInitScript(() => {
    const define = customElements.define.bind(customElements);
    customElements.define = (name, ...rest) => {
      if (name === "family-navigator") throw new DOMException("refused for this test", "NotSupportedError");
      return define(name, ...rest);
    };
  });
  await stub(page);
  await page.goto("/tree/?focus=I8001", { waitUntil: "domcontentloaded" });
  await expectOutlineOnly(page, errors);
});

test("outline-only mode is not remembered: the next visit tries the cards again", async ({ page }) => {
  await stub(page);
  await page.route("**/js/islands/chunks/tree-chart-*.js", (r) => r.abort());
  await page.goto("/tree/?focus=I8001", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-tree-chart-failed]")).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), STORE_KEY)).toBeNull();
  await page.unroute("**/js/islands/chunks/tree-chart-*.js");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(nav(page)).toBeVisible();
  await expect(page.locator("[data-tree-chart-failed]")).toHaveCount(0);
});

test("outline-only mode at 375px: axe clean, no sideways scroll", async ({ page }) => {
  await stub(page);
  await page.route("**/js/islands/chunks/tree-chart-*.js", (r) => r.abort());
  await page.goto("/tree/?focus=I8001", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-tree-chart-failed]")).toBeVisible();
  expect(await axeViolations(page, { include: ".hfy-tree" })).toEqual([]);
  expect(await noSideways(page)).toBe(true);
});

// ---- 2. the cards | outline toggle ----

for (const [width, height] of [[375, 812], [768, 1024], [1280, 900]]) {
  test(`toggle at ${width}px: cards by default, outline on request, back again; 44px targets, axe clean, no sideways scroll`, async ({ page }) => {
    await stub(page);
    await page.setViewportSize({ width, height });
    await page.goto("/tree/?focus=I8001", { waitUntil: "domcontentloaded" });
    await expect(nav(page)).toBeVisible();
    await expect(toggle(page, "cards")).toHaveAttribute("aria-pressed", "true");
    await expect(toggle(page, "outline")).toHaveAttribute("aria-pressed", "false");
    // both buttons are at least 44 px and the group has a name
    await expect(page.getByRole("group", { name: "view" })).toBeVisible();
    for (const v of ["cards", "outline"]) {
      const box = await toggle(page, v).boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    expect(await axeViolations(page, { include: ".hfy-tree" })).toEqual([]);
    // outline view: the cards are gone, the focus navigator and the outline stay, and the choice is in the address and in storage
    await toggle(page, "outline").click();
    await expect(nav(page)).toHaveCount(0);
    await expect(toggle(page, "outline")).toHaveAttribute("aria-pressed", "true");
    await expect(focusName(page)).toHaveText("Robin Quill");
    await expect(outline(page)).toBeVisible();
    await expect(page).toHaveURL(/view=outline/);
    await expect(page).toHaveURL(/focus=I8001/);
    expect(await page.evaluate((k) => localStorage.getItem(k), STORE_KEY)).toBe("outline");
    expect(await axeViolations(page, { include: ".hfy-tree" })).toEqual([]);
    expect(await noSideways(page)).toBe(true);
    // and back
    await toggle(page, "cards").click();
    await expect(nav(page)).toBeVisible();
    await expect(page).toHaveURL(/view=cards/);
    expect(await page.evaluate((k) => localStorage.getItem(k), STORE_KEY)).toBe("cards");
    expect(await noSideways(page)).toBe(true);
  });
}

test("toggle by keyboard: Tab to the button, Enter switches, Space switches back", async ({ page }) => {
  await stub(page);
  await page.goto("/tree/?focus=I8001", { waitUntil: "domcontentloaded" });
  await expect(nav(page)).toBeVisible();
  await toggle(page, "outline").focus();
  await page.keyboard.press("Enter");
  await expect(nav(page)).toHaveCount(0);
  await expect(toggle(page, "outline")).toBeFocused();
  await toggle(page, "cards").focus();
  await page.keyboard.press("Space");
  await expect(nav(page)).toBeVisible();
});

test("?view=outline opens the outline view and never asks for the chart chunk", async ({ page }) => {
  const seen = await stub(page);
  await page.goto("/tree/?focus=I8001&view=outline", { waitUntil: "domcontentloaded" });
  await expect(focusName(page)).toHaveText("Robin Quill");
  await expect(toggle(page, "outline")).toHaveAttribute("aria-pressed", "true");
  await expect(nav(page)).toHaveCount(0);
  await expect(page.locator("[data-tree-chart-failed]")).toHaveCount(0);
  expect(seen.chunk).toBe(0);
});

test("?view=chart (the ADR's word) and ?view=cards open the cards", async ({ page }) => {
  await stub(page);
  for (const v of ["chart", "cards"]) {
    await page.goto(`/tree/?focus=I8001&view=${v}`, { waitUntil: "domcontentloaded" });
    await expect(nav(page)).toBeVisible();
    await expect(toggle(page, "cards")).toHaveAttribute("aria-pressed", "true");
  }
});

test("localStorage['hfy:tree-view'] is honoured, and ?view= beats it", async ({ page }) => {
  await stub(page);
  await page.addInitScript(([k]) => { try { if (!sessionStorage.getItem("seeded")) { localStorage.setItem(k, "outline"); sessionStorage.setItem("seeded", "1"); } } catch { /* ignore */ } }, [STORE_KEY]);
  await page.goto("/tree/?focus=I8001", { waitUntil: "domcontentloaded" });
  await expect(toggle(page, "outline")).toHaveAttribute("aria-pressed", "true");
  await expect(nav(page)).toHaveCount(0);
  await page.goto("/tree/?focus=I8001&view=cards", { waitUntil: "domcontentloaded" });
  await expect(nav(page)).toBeVisible();
});

test("the choice survives a reload; a re-centre keeps the view; Back keeps the reader's choice, not an older entry's", async ({ page }) => {
  await stub(page);
  await page.goto("/tree/?focus=I8001", { waitUntil: "domcontentloaded" });
  await toggle(page, "outline").click();
  await page.goto("/tree/?focus=I8001", { waitUntil: "domcontentloaded" }); // a fresh address with no view: the stored choice applies
  await expect(toggle(page, "outline")).toHaveAttribute("aria-pressed", "true");
  await expect(nav(page)).toHaveCount(0);
  await toggle(page, "outline").click(); // puts the view in this entry's address
  await expect(page).toHaveURL(/view=outline/);
  await page.locator("[data-tree-focus] button[data-person='I8002']").click();
  await expect(focusName(page)).toHaveText("Sam Quill");
  await expect(page).toHaveURL(/view=outline/);
  await expect(page).toHaveURL(/focus=I8002/);
  await toggle(page, "cards").click();
  await expect(nav(page)).toBeVisible();
  await page.goBack();
  await expect(focusName(page)).toHaveText("Robin Quill");
  await expect(toggle(page, "cards")).toHaveAttribute("aria-pressed", "true");
  await expect(nav(page)).toBeVisible();
  await expect(page).toHaveURL(/view=cards/);
});

test("a localStorage that throws still renders: cards by default, and the toggle still works", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("blocked for this test", "SecurityError"); } });
  });
  await stub(page);
  await page.goto("/tree/?focus=I8001", { waitUntil: "domcontentloaded" });
  await expect(nav(page)).toBeVisible();
  await expect(focusName(page)).toHaveText("Robin Quill");
  await toggle(page, "outline").click();
  await expect(nav(page)).toHaveCount(0);
  await expect(outline(page)).toBeVisible();
  await page.goto("/tree/?focus=I8001&view=outline", { waitUntil: "domcontentloaded" });
  await expect(toggle(page, "outline")).toHaveAttribute("aria-pressed", "true");
  expect(errors).toEqual([]);
});

test("a localStorage whose getItem and setItem throw still renders too", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("quota", "QuotaExceededError"); };
    Storage.prototype.setItem = () => { throw new DOMException("quota", "QuotaExceededError"); };
  });
  await stub(page);
  await page.goto("/tree/?focus=I8001", { waitUntil: "domcontentloaded" });
  await expect(nav(page)).toBeVisible();
  await toggle(page, "outline").click();
  await expect(nav(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the noscript line stays on the page, and is what a visitor without JavaScript sees", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await ctx.newPage();
  await page.goto("/tree/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("noscript p")).toContainText("the family tree needs JavaScript");
  await expect(page.locator("noscript a[href='/search/']")).toHaveText("search");
  await ctx.close();
  const html = readFileSync(new URL("../../11ty/tree/index.html", import.meta.url), "utf8");
  expect(html).toMatch(/<noscript><p>the family tree needs JavaScript\./);
});

// ---- 3. the viz.md section 7 states, with the cards view ----
// Each runs with the cards view in force (?view=cards), so the chart is what the ready state would have shown.

test("cards view, 401: refreshes once, retries once, then signs in with returnTo (the view included)", async ({ page }) => {
  const seen = await stub(page, { graph: { status: 401, body: JSON.stringify({ error: "unauthenticated" }) } });
  await page.goto("/tree/?focus=I8001&view=cards", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/auth\/login\?returnTo=/);
  expect(decodeURIComponent(new URL(page.url()).searchParams.get("returnTo"))).toBe("/tree/?focus=I8001&view=cards");
  expect(seen.refresh).toBe(1);
  expect(seen.graph).toBe(2);
});

test("cards view, 403 and 404: 'the family tree is being prepared', no cards and no toggle", async ({ page }) => {
  for (const status of [403, 404]) {
    await stub(page, { graph: { status, body: "<Error/>" } });
    await page.goto("/tree/?focus=I8001&view=cards", { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-tree-state]")).toHaveText(/the family tree is being prepared\. you can find anyone through search\./);
    await expect(nav(page)).toHaveCount(0);
    await expect(page.locator("[data-tree-views]")).toHaveCount(0);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("cards view, bad schema: the retry state, then the retry loads the cards", async ({ page }) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await stub(page, { graph: (n) => (n === 1 ? { status: 200, body: JSON.stringify({ schemaVersion: 2, people: [], unions: [] }) } : { status: 200, body: MESSY }) });
  await page.goto("/tree/?focus=I8001&view=cards", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-tree-state]")).toContainText("the family tree didn't load. try again.");
  await expect(nav(page)).toHaveCount(0);
  await expect.poll(() => errors.some((e) => e.includes("GRAPH_SCHEMA_UNSUPPORTED"))).toBe(true);
  await page.getByRole("button", { name: "try again" }).click();
  await expect(nav(page).locator(".hfy-nav__card--focus .hfy-nav__name")).toHaveText("Robin Quill");
  await expect(toggle(page, "cards")).toHaveAttribute("aria-pressed", "true");
});

// ---- 4. a face that fails to load becomes initials with no layout shift ----

test("faces: every face route answers 404 late: initials in the same boxes, and CLS at most 0.05", async ({ page }) => {
  await page.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  // the 404 arrives after the cards have painted, which is the worst case for a shift
  await stub(page, { faces: async (r) => { await new Promise((ok) => setTimeout(ok, 400)); return r.fulfill({ status: 404, body: "" }); } });
  await page.goto("/tree/?focus=I8001", { waitUntil: "domcontentloaded" });
  await expect(nav(page).locator(".hfy-nav__card--focus .hfy-nav__name")).toHaveText("Robin Quill");
  const box = () => nav(page).locator(".hfy-nav__card--focus .hfy-nav__avatar").boundingBox();
  const before = await box();
  // every image the cards drew has been replaced by initials
  await expect(nav(page).locator("img.hfy-nav__face")).toHaveCount(0, { timeout: 5000 });
  await expect(nav(page).locator(".hfy-nav__card--focus .hfy-nav__initials")).toHaveText("RQ");
  const after = await box();
  expect(after).toEqual(before);
  await page.waitForTimeout(500);
  const cls = await page.evaluate(() => window.__cls);
  expect(cls).toBeLessThanOrEqual(0.05);
});

test("faces: a face that is not an image (200 with garbage) also becomes initials", async ({ page }) => {
  await stub(page, { faces: (r) => r.fulfill({ status: 200, contentType: "image/webp", body: "not an image" }) });
  await page.goto("/tree/?focus=I8001", { waitUntil: "domcontentloaded" });
  await expect(nav(page).locator(".hfy-nav__card--focus .hfy-nav__name")).toHaveText("Robin Quill");
  await expect(nav(page).locator("img.hfy-nav__face")).toHaveCount(0, { timeout: 5000 });
  await expect(nav(page).locator(".hfy-nav__card--focus .hfy-nav__initials")).toHaveText("RQ");
});
