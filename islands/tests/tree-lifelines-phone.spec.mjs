// HFY-TSK-305 (viz-v2-time-phone): the lifelines on phones (one branch per panel, previous and next, no sideways scroll at 320 and 375), the table view
// (the screen-reader path, the same people as the lifelines), and the D-11 audit of /tree/ lifelines and table at 375, 768 and 1280 with
// ?hfy_flags=familyVizTime. Hermetic: flags, session and graph are route-stubbed with synthetic data (invented names; tests/fixtures/lifelines-graph.json).
// With HFY_AUDIT_SHOTS=<dir> each audited state is also saved as a screenshot (the evidence for the flip task, under the task asset prefix, HFY-R16).
//   HFY_SITE=<dir> PW_PORT=<port> [HFY_AUDIT_SHOTS=<dir>] npx playwright test tests/tree-lifelines-phone.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { axeViolations } from "./axe.mjs";
import { MEASURE } from "./d11-measure.mjs";

const SMALL = readFileSync(new URL("./fixtures/lifelines-graph.json", import.meta.url), "utf8");
const SHOTS = process.env.HFY_AUDIT_SHOTS || "";

async function open(page, { flags = { familyVizTime: true }, url = "/tree/?focus=I8010&view=lifelines", width = 375, height = 812 } = {}) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, familyViz: true, ...flags } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: "I8010", label: "Jun Quillon" } }));
  await page.route("**/person/graph.json", (r) => r.fulfill({ status: 200, contentType: "application/json", body: SMALL }));
  await page.setViewportSize({ width, height });
  await page.goto(url, { waitUntil: "domcontentloaded" });
}
const life = (page) => page.locator("[data-tree-lifelines]");
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const width of [320, 375]) {
  test(`${width}px: time runs down the screen, one branch per panel, previous and next buttons, and no sideways scroll`, async ({ page }) => {
    await open(page, { width });
    await expect(life(page)).toBeVisible();
    await expect(life(page)).toHaveAttribute("data-life-phone", "true");
    const n = Number(await life(page).getAttribute("data-life-branches"));
    expect(n).toBeGreaterThan(2);
    const pos = life(page).locator("[data-life-position]");
    await expect(pos).toHaveText(new RegExp(`^branch 1 of ${n}: Rowan Thistle$`));
    const prev = life(page).locator("[data-life-prev]");
    const next = life(page).locator("[data-life-next]");
    await expect(prev).toBeDisabled();
    // panel 0: the parents and the focus person only; people under their decade, oldest first
    await expect(life(page).locator("[data-lifeline]")).toHaveCount(3);
    const decades = await life(page).locator(".hfy-life__decade").allTextContents();
    expect(decades).toEqual([...decades].sort());
    expect(await noSideScroll(page)).toBe(true);
    // no gesture: only buttons walk the branches, to the last and back
    for (let i = 2; i <= n; i += 1) {
      await next.click();
      await expect(pos).toHaveText(new RegExp(`^branch ${i} of ${n}: `));
      expect(await noSideScroll(page)).toBe(true);
    }
    await expect(next).toBeDisabled();
    await prev.click();
    await expect(pos).toHaveText(new RegExp(`^branch ${n - 1} of ${n}: `));
  });
}

test("a branch holds a partner and the union's children; choosing a person opens the navigator on them", async ({ page }) => {
  await open(page);
  await life(page).locator("[data-life-next]").click();
  await expect(life(page).locator("[data-lifeline='I8020']")).toBeVisible();
  await expect(life(page).locator("[data-lifeline='I8030']")).toBeVisible();
  await life(page).getByRole("button", { name: /^Wren Alder,/ }).click();
  await expect(page).toHaveURL(/focus=I8020/);
  await expect(page.locator("family-navigator .hfy-nav__card--focus .hfy-nav__name")).toHaveText("Wren Alder");
});

test("from 43rem the desktop lifelines stay; at 42rem the phone panels show", async ({ page }) => {
  await open(page, { width: 768 });
  await expect(life(page)).toBeVisible();
  await expect(life(page)).not.toHaveAttribute("data-life-phone", "true");
  await page.setViewportSize({ width: 672, height: 800 });
  await expect(life(page)).toHaveAttribute("data-life-phone", "true");
});

test("the table view is on the toggle and lists the same people as the lifelines (the screen-reader path)", async ({ page }) => {
  await open(page, { width: 1280 });
  await expect(life(page).locator("[data-lifeline]")).toHaveCount(10);
  const ids = await life(page).locator("[data-lifeline]").evaluateAll((els) => els.map((e) => e.getAttribute("data-lifeline")));
  expect(ids.length).toBeGreaterThan(5);
  await page.locator("[data-tree-view='table']").click();
  await expect(page.locator("[data-tree-view='table']")).toHaveAttribute("aria-pressed", "true");
  const table = page.getByRole("table", { name: /everyone in these lifelines/ });
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader")).toHaveText(["person", "born", "died", "events"]);
  const tableIds = await table.locator("tbody tr").evaluateAll((els) => els.map((e) => e.getAttribute("data-life-person")));
  expect(tableIds).toEqual(ids);
  // names are links to the person page (P2-R46), years and events are in words
  await expect(table.getByRole("rowheader", { name: "Wren Alder" }).getByRole("link")).toHaveAttribute("href", /\/person\/\?id=I8020/);
  const row = table.locator("tr[data-life-person='I8010']");
  await expect(row.locator("td").nth(0)).toHaveText("1908");
  await expect(row.locator("td").nth(1)).toHaveText("1985");
  await expect(row.locator("td").nth(2)).toContainText("family with Wren Alder from about 1932, 2 children");
  await expect(table.locator("tr[data-life-person='I8031'] td").nth(1)).toHaveText("living");
  await expect(table.locator("tr[data-life-person='I8033'] td").nth(0)).toHaveText("unknown");
});

test("the table at 320px has no sideways scroll, and ?view=table is a deep link", async ({ page }) => {
  await open(page, { width: 320, url: "/tree/?focus=I8010&view=table" });
  await expect(page.locator("[data-life-table]")).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page, { include: "[data-tree-lifelines]" })).toEqual([]);
});

test("the table view is not offered with the flag off, and ?view=table falls back to the cards", async ({ page }) => {
  await open(page, { flags: {}, url: "/tree/?focus=I8010&view=table" });
  await expect(page.locator("family-navigator .hfy-nav__card--focus")).toBeVisible();
  await expect(page.locator("[data-tree-view='table']")).toHaveCount(0);
  await expect(page.locator("[data-life-table]")).toHaveCount(0);
});

// The D-11 audit (16 px names, 44 px targets, no sideways scroll, axe serious and critical), with the flag set by the preview parameter.
for (const [name, width] of [["375", 375], ["768", 768], ["1280", 1280]]) {
  for (const view of ["lifelines", "table"]) {
    test(`D-11 audit at ${name}px, ${view}, ?hfy_flags=familyVizTime`, async ({ page }) => {
      await open(page, { flags: {}, width: Number(name), url: `/tree/?focus=I8010&view=${view}&hfy_flags=familyVizTime` });
      await expect(life(page)).toBeVisible();
      const names = await page.locator("[data-tree-lifelines] .hfy-life__name, [data-tree-lifelines] tbody th a").evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width).map((e) => parseFloat(getComputedStyle(e).fontSize)));
      for (const px of names) expect(px).toBeGreaterThanOrEqual(16);
      const findings = [...(await page.evaluate(`(${MEASURE.toString()})()`)), ...(await axeViolations(page)).map((v) => `axe ${v}`)];
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: join(SHOTS, `tree-${view}-${name}.png`), fullPage: true });
      }
      expect(findings, `${view} at ${name}px`).toEqual([]);
      if (name === "375") {
        await page.setViewportSize({ width: 320, height: 800 });
        expect(await noSideScroll(page)).toBe(true);
      }
    });
  }
}
