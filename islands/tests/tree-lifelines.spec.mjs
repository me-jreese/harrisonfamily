// HFY-TSK-269 (viz-v2-time): the lifelines view of /tree/ behind familyVizTime, on a desktop width. Hermetic: /_data/flags.json, /auth/session and
// /person/graph.json are route-stubbed with synthetic graphs (invented names; tests/fixtures/lifelines-graph.json, and synthGraph(2000)).
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/tree-lifelines.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { synthGraph } from "./fixtures/graph-synth.mjs";
import { axeViolations } from "./axe.mjs";

const SMALL = readFileSync(new URL("./fixtures/lifelines-graph.json", import.meta.url), "utf8");
const BIG = JSON.stringify(synthGraph(2000));

async function open(page, { graph = SMALL, focus = "I8010", flags = { familyVizTime: true }, sub = "I8010", url = `/tree/?focus=${focus}&view=lifelines`, width = 1280 } = {}) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, familyViz: true, ...flags } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub, label: "Jun Quillon" } }));
  await page.route("**/person/graph.json", (r) => r.fulfill({ status: 200, contentType: "application/json", body: graph }));
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(url, { waitUntil: "domcontentloaded" });
}
const life = (page) => page.locator("[data-tree-lifelines]");

test("a person in two unions: each union converges at its own first child; the strips read in words", async ({ page }) => {
  await open(page);
  await expect(life(page)).toBeVisible();
  await expect(life(page).locator("[data-lifeline]")).toHaveCount(10);
  // the two unions of the focus person have separate markers at separate x positions
  const x = async (key) => Number(await life(page).locator(`[data-life-node="F8010"]`).first().getAttribute("cx").then((v) => v.replace("%", "")));
  const x1 = await x("F8010");
  const x2 = Number((await life(page).locator(`[data-life-node="F8011"]`).first().getAttribute("cx")).replace("%", ""));
  expect(x2).toBeGreaterThan(x1);
  // the accessible names carry the years in words, and the family year
  await expect(life(page).getByRole("button", { name: /^Wren Alder, about 1912 to 1980, family from about 1932$/ })).toBeVisible();
  await expect(life(page).getByRole("button", { name: /^Sable Dunmere, 1920 to 1999, family from about 1950$/ })).toBeVisible();
  // a union with no dated child does not converge; its partner is still there
  await expect(life(page).locator("[data-life-node='F8012']")).toHaveCount(0);
  await expect(life(page).getByRole("button", { name: /^Linnet Hollin, 1925 to 1930$/ })).toBeVisible();
  // a one-event person is a dot; a living person runs to today; an approximate person fades; nobody known is a row with no mark
  await expect(life(page).locator("[data-lifeline='I8030'] [data-life-mark='dot']")).toHaveCount(1);
  await expect(life(page).locator("[data-lifeline='I8031'] [data-life-ongoing='true']")).toHaveCount(1);
  await expect(life(page).locator("[data-lifeline='I8020'] [data-life-fuzzy='true']")).toHaveCount(1);
  await expect(life(page).locator("[data-lifeline='I8033'] [data-life-mark]")).toHaveCount(0);
  await expect(life(page).getByRole("button", { name: "Nell Quillon, years unknown" })).toBeVisible();
});

test("decades only: no era band renders", async ({ page }) => {
  await open(page);
  await expect(life(page)).toBeVisible();
  await expect(life(page).locator("[class*='era'], [class*='band'], [data-era], [data-band], [data-era-band]")).toHaveCount(0);
  await expect(life(page).locator(".hfy-life__tick-label").first()).toHaveText(/^\d{4}$/);
});

test("each lifeline is a button; choosing it opens the navigator focused on that person", async ({ page }) => {
  await open(page);
  const line = life(page).getByRole("button", { name: /^Wren Alder,/ });
  await line.click();
  await expect(page).toHaveURL(/focus=I8020/);
  await expect(page).toHaveURL(/view=cards/);
  await expect(life(page)).toHaveCount(0);
  await expect(page.locator("family-navigator .hfy-nav__card--focus .hfy-nav__name")).toHaveText("Wren Alder");
  await expect(page.locator("[data-tree-focus='I8020'] h2")).toHaveText("Wren Alder");
});

test("Back after choosing a lifeline returns to the lifelines of the earlier focus; focus lands on the navigator heading", async ({ page }) => {
  await open(page);
  await life(page).getByRole("button", { name: /^Wren Alder,/ }).click();
  await expect(page).toHaveURL(/focus=I8020/);
  await expect(page.locator("#hfy-tree-focus-name")).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(/focus=I8010/);
  await expect(life(page)).toBeVisible();
});

test("the lifelines chunk failing falls back to the cards", async ({ page }) => {
  await page.route("**/chunks/tree-lifelines-*.js", (r) => r.abort());
  await open(page);
  await expect(page.locator("family-navigator, [data-tree-focus]").first()).toBeVisible();
  await expect(life(page)).toHaveCount(0);
});

test("a 2,000-person graph: at most 40 lifelines, and the rest collapse into '+N more in <name>'s family' buttons that re-centre", async ({ page }) => {
  await open(page, { graph: BIG, sub: "I99999", url: "/tree/?view=lifelines" });
  await expect(life(page)).toBeVisible();
  const n = await life(page).locator("[data-lifeline]").count();
  expect(n).toBeGreaterThan(20);
  expect(n).toBeLessThanOrEqual(40);
  const more = life(page).locator("[data-lifeline-more]");
  expect(await more.count()).toBeGreaterThan(0);
  await expect(more.first()).toHaveText(/^\+\d+ more in .+'s family$/);
  const id = await more.first().getAttribute("data-lifeline-more");
  await more.first().click();
  await expect(page).toHaveURL(new RegExp(`focus=${id}`));
  // the lifelines stay, now centred on that family, still within the cap
  await expect(life(page)).toHaveAttribute("data-tree-lifelines", id);
  expect(await life(page).locator("[data-lifeline]").count()).toBeLessThanOrEqual(40);
});

test("the flag is off by default: no lifelines toggle, and ?view=lifelines falls back to the cards", async ({ page }) => {
  await open(page, { flags: {} });
  await expect(page.locator("family-navigator .hfy-nav__card--focus")).toBeVisible();
  await expect(page.locator("[data-tree-view='lifelines']")).toHaveCount(0);
  await expect(life(page)).toHaveCount(0);
  await expect(page.locator("[data-tree-mode]")).toHaveAttribute("data-tree-mode", "cards");
});

test("with the flag on the toggle offers lifelines, and the view passes axe", async ({ page }) => {
  await open(page, { url: "/tree/?focus=I8010" });
  await expect(page.locator("[data-tree-view='lifelines']")).toBeVisible();
  await page.locator("[data-tree-view='lifelines']").click();
  await expect(life(page)).toBeVisible();
  await expect(page.locator("[data-tree-view='lifelines']")).toHaveAttribute("aria-pressed", "true");
  expect(await axeViolations(page, { include: "[data-tree-lifelines]" })).toEqual([]);
});
