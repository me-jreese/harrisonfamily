// HFY-TSK-272 (viz-v2-bigtree, flag familyVizBigTree): the whole-family poster. Hermetic: /_data/flags.json, /auth/* and /person/graph.json are
// route-stubbed with the synthetic fixtures/tree-graph-poster.json (invented names; a pedigree collapse, a second group, a singleton).
//   HFY_SITE=<dir> PW_PORT=<port> PW_CHANNEL=chromium-headless-shell npx playwright test tests/tree-bigtree.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const GRAPH = readFileSync(new URL("./fixtures/tree-graph-poster.json", import.meta.url), "utf8");
const NO_LAYOUT = JSON.stringify((() => { const d = JSON.parse(GRAPH); delete d.layout; d.minor = 0; return d; })());

async function stub(page, { flag = true, graph = GRAPH, sub = "I9209" } = {}) {
  const seen = { urls: [] };
  page.on("request", (r) => seen.urls.push(new URL(r.url()).pathname));
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, familyViz: true, familyVizBigTree: flag } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub, label: "Bea Marsh" } }));
  await page.route("**/media/faces/**", (r) => r.fulfill({ status: 404, body: "" }));
  await page.route("**/person/graph.json", (r) => r.fulfill({ status: 200, contentType: "application/json", body: graph }));
  return seen;
}
const toggle = (page) => page.locator("[data-tree-views]");
const poster = (page) => page.locator("[data-tree-poster]");

test("375: the whole-family view is not offered, and ?view=family reads as the cards", async ({ page }) => {
  const seen = await stub(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/tree/?view=family", { waitUntil: "domcontentloaded" });
  await expect(page.locator("family-navigator .hfy-nav__card--focus")).toBeVisible();
  await expect(toggle(page).getByRole("button")).toHaveText(["cards", "outline"]);
  await expect(page.locator("[data-tree-view=family]")).toHaveCount(0);
  await expect(poster(page)).toHaveCount(0);
  expect(seen.urls.some((u) => /tree-bigtree/.test(u))).toBe(false);
});

test("1280 with the flag off: no whole-family button", async ({ page }) => {
  await stub(page, { flag: false });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tree/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("family-navigator .hfy-nav__card--focus")).toBeVisible();
  await expect(page.locator("[data-tree-view=family]")).toHaveCount(0);
});

test("1280: 'whole family' draws the layout as SVG: cards as buttons, union connectors, elbow links, one card per person", async ({ page }) => {
  const seen = await stub(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tree/", { waitUntil: "domcontentloaded" });
  await expect(toggle(page).getByRole("button")).toHaveText(["cards", "outline", "whole family"]);
  expect(seen.urls.some((u) => /tree-bigtree/.test(u))).toBe(false);
  await page.locator("[data-tree-view=family]").click();
  await expect(poster(page)).toBeVisible();
  await expect(page).toHaveURL(/view=family/);
  const svgs = poster(page).locator("svg.hfy-poster__svg");
  await expect(svgs).toHaveCount(2);
  await expect(poster(page).getByRole("button")).toHaveCount(12);
  await expect(poster(page).locator("circle.hfy-poster__union")).toHaveCount(5);
  await expect(poster(page).locator("path.hfy-poster__link")).toHaveCount(16);
  expect(await poster(page).locator("path.hfy-poster__link").first().getAttribute("d")).toMatch(/^M\d+ \d+ V\d+ H\d+ V\d+$/);
  await expect(poster(page).getByRole("button", { name: /^Gus Quay, 1955 to 2025$/ })).toBeVisible();
  // one card for the shared ancestor
  await expect(poster(page).locator("[data-person=I9201]")).toHaveCount(1);
  // the page does not scroll sideways; the poster scrolls inside its own region
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await poster(page).locator("[data-poster-scroll]").evaluate((el) => el.scrollWidth >= el.clientWidth)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
});

test("1280: a pedigree-collapsed person appears once with the 'also your ancestor through' badge", async ({ page }) => {
  await stub(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tree/?view=family", { waitUntil: "domcontentloaded" });
  await expect(poster(page)).toBeVisible();
  const una = poster(page).locator("[data-person=I9201]");
  await expect(una).toHaveCount(1);
  await expect(una).toHaveAccessibleName(/^Una Fenn, 1900 to 1970, also your ancestor through (Zed Fenn|Abe Marsh)$/);
  await expect(una.locator("[data-badge]")).toHaveCount(1);
  await expect(poster(page).locator("[data-badge]")).toHaveCount(2);
  await expect(poster(page).locator("[data-person=I9203] [data-badge]")).toHaveCount(0);
  // the hover label carries the whole sentence, with the name as a link (P2-R46)
  await una.focus();
  const label = poster(page).locator("[data-poster-label]");
  await expect(label).toContainText("also your ancestor through");
  await expect(label.getByRole("link", { name: "Una Fenn" })).toHaveAttribute("href", "/person/?id=I9201");
});

test("1280: names are drawn at 16 px or more; where one would be smaller the card shows initials only, and the name stays in its accessible name", async ({ page }) => {
  await stub(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tree/?view=family", { waitUntil: "domcontentloaded" });
  const svg = poster(page).locator("svg.hfy-poster__svg").first();
  await expect(svg).toHaveAttribute("data-names", "on");
  const sizes = () => svg.evaluate((el) => [...el.querySelectorAll(".hfy-poster__name")].map((t) => parseFloat(getComputedStyle(t).fontSize) * t.getScreenCTM().a));
  const full = await sizes();
  expect(full.length).toBe(9);
  for (const px of full) expect(px).toBeGreaterThanOrEqual(15.99);
  // shown at 60% of its layout width (a zoomed out view): no name text at all, an initials avatar on every card
  await svg.evaluate((el) => { el.style.width = `${el.viewBox.baseVal.width * 0.6}px`; el.style.height = "auto"; });
  await expect(svg).toHaveAttribute("data-names", "off");
  expect(await sizes()).toEqual([]);
  await expect(svg.locator(".hfy-poster__name")).toHaveCount(0);
  await expect(svg.locator(".hfy-poster__initials").first()).toBeVisible();
  const inits = await svg.locator(".hfy-poster__initials").allTextContents();
  expect(inits.length).toBe(9);
  expect(inits).toContain("UF");
  for (const px of await svg.evaluate((el) => [...el.querySelectorAll(".hfy-poster__initials")].map((t) => parseFloat(getComputedStyle(t).fontSize) * 1))) expect(px).toBeGreaterThanOrEqual(15.99);
  await expect(svg.getByRole("button", { name: /^Una Fenn,/ })).toBeVisible();
  // and back
  await svg.evaluate((el) => { el.style.width = ""; el.style.height = ""; });
  await expect(svg).toHaveAttribute("data-names", "on");
});

test("1280: choosing a card opens the navigator on that person (Enter works too)", async ({ page }) => {
  await stub(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tree/?view=family", { waitUntil: "domcontentloaded" });
  await poster(page).locator("[data-person=I9203]").click();
  await expect(poster(page)).toHaveCount(0);
  await expect(page).toHaveURL(/focus=I9203/);
  await expect(page.locator("family-navigator .hfy-nav__card--focus")).toContainText("Wes Fenn");
  await page.locator("[data-tree-view=family]").click();
  await poster(page).locator("[data-person=I9212]").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/focus=I9212/);
  await expect(poster(page)).toHaveCount(0);
});

test("1280 without a layout block: 'the whole-family view is being prepared', and nothing more is loaded", async ({ page }) => {
  const seen = await stub(page, { graph: NO_LAYOUT });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tree/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("family-navigator .hfy-nav__card--focus")).toBeVisible();
  await page.locator("[data-tree-view=family]").click();
  await expect(page.locator("[data-tree-poster-prepared]")).toHaveText("the whole-family view is being prepared.");
  await expect(poster(page)).toHaveCount(0);
  const before = seen.urls.length;
  await page.waitForTimeout(800);
  expect(seen.urls.length).toBe(before);
  expect(seen.urls.some((u) => /tree-bigtree/.test(u))).toBe(false);
});

test("resizing below 64rem puts the whole-family view away (the cards take over)", async ({ page }) => {
  await stub(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tree/?view=family", { waitUntil: "domcontentloaded" });
  await expect(poster(page)).toBeVisible();
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(poster(page)).toHaveCount(0);
  await expect(page.locator("[data-tree-view=family]")).toHaveCount(0);
  await expect(page.locator("family-navigator")).toBeVisible();
});
