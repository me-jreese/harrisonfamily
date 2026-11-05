// HFY-TSK-309 (viz-v2-bigtree-nav, flag familyVizBigTree): poster navigation. Hermetic like tree-bigtree.spec.mjs (route-stubbed flags, session and the synthetic
// fixtures/tree-graph-poster.json). Covers: the buttons and the minimap do what the gestures do; the wheel zooms only with Ctrl or Cmd; a mouse drag pans
// inside the region only; touch never pans or zooms the poster; Tab reaches every card and scrolls it into view; and the D-11 audit at 1280, 1920 and
// 375 (the view is absent there), with 320 and 375 free of sideways page scroll. With HFY_AUDIT_SHOTS=<dir> the audit also saves screenshots (HFY-R16 asset prefix).
//   HFY_SITE=<dir> PW_PORT=<port> PW_CHANNEL=chromium-headless-shell npx playwright test tests/tree-bigtree-nav.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { axeViolations } from "./axe.mjs";
import { MEASURE } from "./d11-measure.mjs";

const GRAPH = readFileSync(new URL("./fixtures/tree-graph-poster.json", import.meta.url), "utf8");
const SHOTS = process.env.HFY_AUDIT_SHOTS || "";

async function stub(page, { sub = "I9209" } = {}) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, familyViz: true, familyVizBigTree: true } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub, label: "Bea Marsh" } }));
  await page.route("**/media/faces/**", (r) => r.fulfill({ status: 404, body: "" }));
  await page.route("**/person/graph.json", (r) => r.fulfill({ status: 200, contentType: "application/json", body: GRAPH }));
}
async function open(page, width = 1024) {
  await stub(page);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/tree/?view=family", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-tree-poster]")).toBeVisible();
}
const region = (page) => page.locator("[data-poster-scroll]");
const zoomOf = async (page) => Number(await region(page).getAttribute("data-zoom"));
const scrollOf = (page) => region(page).evaluate((el) => [el.scrollLeft, el.scrollTop]);

test("1024: zoom in, zoom out, fit and reset buttons each change the view as a gesture would", async ({ page }) => {
  await open(page);
  expect(await zoomOf(page)).toBe(1);
  await page.locator("[data-poster-zoom-in]").click();
  expect(await zoomOf(page)).toBeCloseTo(1.25, 2);
  await expect(page.locator("[data-poster-zoom]")).toHaveText("125%");
  const svg = page.locator("svg.hfy-poster__svg").first();
  expect(Math.round((await svg.boundingBox()).width)).toBe(1350);
  await page.locator("[data-poster-zoom-out]").click();
  await page.locator("[data-poster-zoom-out]").click();
  expect(await zoomOf(page)).toBeCloseTo(0.8, 2);
  // fit: the widest group fits the region, scrolled to the start, and names give way to faces where they would be under 16 px
  await page.locator("[data-poster-fit]").click();
  const fitZ = await zoomOf(page);
  const inner = await region(page).evaluate((el) => el.clientWidth - 2 * parseFloat(getComputedStyle(el).paddingLeft));
  expect(fitZ).toBeCloseTo(inner / 1080, 2);
  expect(await region(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await expect(svg).toHaveAttribute("data-names", "off");
  // reset: real size, with the viewer's own card in the middle of the region
  await page.locator("[data-poster-zoom-in]").click();
  await page.locator("[data-poster-zoom-in]").click();
  await page.locator("[data-poster-reset]").click();
  await expect.poll(() => zoomOf(page)).toBe(1);
  await expect(svg).toHaveAttribute("data-names", "on");
  // when the card cannot be centred (at the start or end of the scroll range) it is as near the middle as the range allows
  await expect.poll(() => region(page).evaluate((el) => {
    const a = el.querySelector("[data-person=I9209]").getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const sl = el.scrollLeft, st = el.scrollTop;
    const dx = Math.abs(a.left + a.width / 2 - (r.left + r.width / 2));
    const dy = Math.abs(a.top + a.height / 2 - (r.top + r.height / 2));
    return (dx < 2 || sl <= 1 || sl >= el.scrollWidth - el.clientWidth - 1) && (dy < 2 || st <= 1 || st >= el.scrollHeight - el.clientHeight - 1);
  })).toBe(true);
  // the buttons stop at the limits
  for (let i = 0; i < 12; i += 1) await page.locator("[data-poster-zoom-in]").click({ force: true });
  expect(await zoomOf(page)).toBe(2);
  await expect(page.locator("[data-poster-zoom-in]")).toHaveAttribute("aria-disabled", "true");
});

test("1024: the minimap shows every card and the visible frame, and pressing or dragging on it moves the view", async ({ page }) => {
  await open(page);
  await expect(page.locator(".hfy-poster__minicard")).toHaveCount(12);
  for (let i = 0; i < 3; i += 1) await page.locator("[data-poster-zoom-in]").click();
  await region(page).evaluate((el) => { el.scrollLeft = 0; el.scrollTop = 0; });
  const frame = page.locator("[data-poster-miniview]");
  await expect.poll(async () => Number(await frame.getAttribute("x"))).toBe(0);
  const mini = await page.locator(".hfy-poster__minisvg").boundingBox();
  const [l0] = await scrollOf(page);
  await page.mouse.click(mini.x + mini.width * 0.9, mini.y + 4);
  await expect.poll(async () => (await scrollOf(page))[0]).toBeGreaterThan(l0 + 100);
  expect(Number(await frame.getAttribute("x"))).toBeGreaterThan(0);
  // dragging on the minimap keeps moving it
  const [l1] = await scrollOf(page);
  await page.mouse.move(mini.x + mini.width * 0.9, mini.y + 4);
  await page.mouse.down();
  await page.mouse.move(mini.x + mini.width * 0.3, mini.y + 4, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await scrollOf(page))[0]).toBeLessThan(l1);
});

test("1024: the wheel zooms only with Ctrl (or Cmd); a plain wheel scrolls", async ({ page }) => {
  await open(page);
  await page.locator("[data-poster-zoom-in]").click();
  const box = await region(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(150);
  expect(await zoomOf(page)).toBeCloseTo(1.25, 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -300);
  await page.keyboard.up("Control");
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(1.3);
  const z = await zoomOf(page);
  await page.keyboard.down("Meta");
  await page.mouse.wheel(0, 300);
  await page.keyboard.up("Meta");
  await expect.poll(() => zoomOf(page)).toBeLessThan(z);
});

test("1024: a mouse drag pans inside the poster region only", async ({ page }) => {
  await open(page);
  for (let i = 0; i < 3; i += 1) await page.locator("[data-poster-zoom-in]").click();
  await region(page).evaluate((el) => { el.scrollLeft = 300; el.scrollTop = 100; });
  const box = await region(page).boundingBox();
  const [l0, t0] = await scrollOf(page);
  await page.mouse.move(box.x + 400, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 150, { steps: 5 });
  await page.mouse.up();
  const [l1, t1] = await scrollOf(page);
  expect(l1 - l0).toBeGreaterThan(80);
  expect(t1 - t0).toBeGreaterThan(30);
  await expect(page.locator("[data-tree-poster]")).toBeVisible();
  // a drag that starts outside the region (on the heading) does nothing to it
  const h = await page.locator("#hfy-poster-title").boundingBox();
  await page.mouse.move(h.x + 4, h.y + 4);
  await page.mouse.down();
  await page.mouse.move(h.x + 200, h.y + 40, { steps: 5 });
  await page.mouse.up();
  expect(await scrollOf(page)).toEqual([l1, t1]);
});

test("touch input never pans or zooms the poster; the region leaves it to the page (touch-action: pan-x pan-y)", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 900 }, hasTouch: true });
  const page = await ctx.newPage();
  await open(page);
  expect(await region(page).evaluate((el) => getComputedStyle(el).touchAction)).toBe("pan-x pan-y");
  expect(await page.locator("svg.hfy-poster__svg").first().evaluate((el) => getComputedStyle(el).touchAction)).toBe("auto");
  for (let i = 0; i < 3; i += 1) await page.locator("[data-poster-zoom-in]").click();
  const z = await zoomOf(page);
  const s0 = await scrollOf(page);
  // a touch pointer drag, and a ctrl wheel is not what a pinch sends here: the poster takes neither
  await region(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: "touch", isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true }));
    fire("pointerdown", r.left + 400, r.top + 200);
    for (let i = 1; i <= 5; i += 1) fire("pointermove", r.left + 400 - i * 30, r.top + 200 - i * 20);
    fire("pointerup", r.left + 250, r.top + 100);
  });
  expect(await scrollOf(page)).toEqual(s0);
  expect(await zoomOf(page)).toBe(z);
  await ctx.close();
});

test("1024: Tab walks every card, and each focused card is scrolled into view", async ({ page }) => {
  await open(page);
  for (let i = 0; i < 4; i += 1) await page.locator("[data-poster-zoom-in]").click();
  await region(page).evaluate((el) => { el.scrollLeft = 0; el.scrollTop = 0; });
  await region(page).focus();
  const seen = [];
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || !a.dataset || !a.dataset.person) return null;
      const reg = document.querySelector("[data-poster-scroll]").getBoundingClientRect();
      const b = a.getBoundingClientRect();
      return { id: a.dataset.person, inView: b.left >= reg.left - 1 && b.right <= reg.right + 1 && b.top >= reg.top - 1 && b.bottom <= reg.bottom + 1 };
    });
    expect(r, `tab ${i + 1}`).not.toBeNull();
    expect(r.inView, `${r.id} in view`).toBe(true);
    seen.push(r.id);
  }
  expect(new Set(seen).size).toBe(12);
});

for (const [width, name] of [[1280, "1280"], [1920, "1920"]]) {
  test(`${name}: D-11 audit of the poster and its controls (axe, 44 px targets, 16 px names, no sideways page scroll)`, async ({ page }) => {
    await open(page, width);
    const tools = await page.locator(".hfy-poster__btn, .hfy-poster__zoom").evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
    for (const px of tools) expect(px).toBeGreaterThanOrEqual(16);
    const findings = await page.evaluate(`(${MEASURE.toString()})()`);
    expect(findings).toEqual([]);
    expect(await axeViolations(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // the same after the buttons have moved the view
    await page.locator("[data-poster-zoom-in]").click();
    await page.locator("[data-poster-fit]").click();
    expect(await axeViolations(page)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `tree-bigtree-nav-${name}.png`), fullPage: true }); }
  });
}

for (const width of [375, 320]) {
  test(`${width}: the poster is absent, the page does not scroll sideways, and axe is clean`, async ({ page }) => {
    await stub(page);
    await page.setViewportSize({ width, height: 812 });
    await page.goto("/tree/?view=family", { waitUntil: "domcontentloaded" });
    await expect(page.locator("family-navigator .hfy-nav__card--focus")).toBeVisible();
    await expect(page.locator("[data-tree-poster]")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await axeViolations(page)).toEqual([]);
    if (SHOTS && width === 375) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, "tree-bigtree-nav-375.png"), fullPage: true }); }
  });
}
