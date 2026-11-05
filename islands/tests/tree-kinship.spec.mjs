// HFY-TSK-307 (viz-v2-kinship-ui): the "how are we related?" panel on /tree/ (flag familyVizKinship). Hermetic: /_data/flags.json, /auth/* and
// /person/graph.json are route-stubbed with the synthetic tests/fixtures/tree-graph-kinship.json (invented names). The flag is turned on the way a
// previewer does it, with ?hfy_flags=familyVizKinship.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/tree-kinship.spec.mjs --workers=1
// HFY_SHOTS_DIR=<dir> also saves the audit screenshots (375, 768, 1280), the acceptance evidence for the flip task (HFY-R16 asset prefix).
import { test, expect } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const GRAPH = readFileSync(new URL("./fixtures/tree-graph-kinship.json", import.meta.url), "utf8");
const VIEWER = "K1000";

async function open(page, { width = 375, height = 900, focus = "K1004", flag = true, sub = VIEWER, authenticated = true } = {}) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, familyViz: true } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: authenticated ? { authenticated: true, sub, label: "Ada Example" } : { authenticated: false } }));
  await page.route("**/person/graph.json", (r) => r.fulfill({ status: 200, contentType: "application/json", body: GRAPH }));
  await page.setViewportSize({ width, height });
  await page.goto(`/tree/?focus=${focus}${flag ? "&hfy_flags=familyVizKinship" : ""}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-tree-focus]")).toBeVisible();
}

const pill = (page) => page.locator("[data-tree-kin-pill]");
const panel = (page) => page.locator("[data-kin-panel]");
const focusId = (page) => new URL(page.url()).searchParams.get("focus");

test("no pill without the flag, and none for a signed-out visitor", async ({ page }) => {
  await open(page, { flag: false });
  await expect(pill(page)).toHaveCount(0);
  const out = await page.context().newPage();
  await open(out, { authenticated: false });
  await expect(pill(out)).toHaveCount(0);
});

test("the pill opens a vertical chain from the viewer up to the common ancestors and down to the person, then one plain sentence", async ({ page }) => {
  await open(page);
  await expect(pill(page)).toHaveText("how are we related?");
  await expect(pill(page)).toHaveAttribute("aria-expanded", "false");
  await expect(panel(page)).toHaveCount(0);
  await pill(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(pill(page)).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("[data-kin-sentence]")).toHaveText("Sorrel Vance is your first cousin.");
  await expect(page.locator("[data-kin-sentence] a")).toHaveAttribute("href", "/person/?id=K1004");
  const steps = page.locator("[data-kin-route='0'] [data-kin-step]");
  await expect(steps).toHaveCount(5);
  await expect(steps.nth(0)).toContainText("Robin Mirren");
  await expect(steps.nth(2)).toContainText("Hale Mirren");
  await expect(steps.nth(2)).toContainText("Ione Mirren");
  await expect(steps.nth(2)).toContainText("common ancestor");
  await expect(steps.nth(4)).toContainText("Sorrel Vance");
  // vertical: each step is below the one before
  const ys = await steps.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  expect(ys).toEqual([...ys].sort((a, b) => a - b));
  expect(new Set(ys).size).toBe(5);
  // every card is a button
  const cards = page.locator("[data-kin-panel] .hfy-kin__card");
  expect(await cards.count()).toBe(6);
  expect(await cards.evaluateAll((els) => els.every((e) => e.tagName === "BUTTON"))).toBe(true);
  // the focus person's card is the current one
  await expect(page.locator("[data-kin-step='4'] .hfy-kin__card")).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("heading", { name: "how are we related?" })).toBeFocused();
});

test("pedigree collapse: both routes are listed", async ({ page }) => {
  await open(page, { focus: "K1020" });
  await pill(page).click();
  await expect(page.locator("[data-kin-sentence]")).toContainText("is your first cousin once removed, through 2 different routes.");
  await expect(page.locator("[data-kin-route]")).toHaveCount(2);
  await expect(page.locator("[data-kin-route='0']")).toContainText("Nell Mirren");
  await expect(page.locator("[data-kin-route='1']")).toContainText("Orin Mirren");
  for (const r of [0, 1]) await expect(page.locator(`[data-kin-route='${r}'] [data-kin-step]`).last()).toContainText("Una Vance");
});

test("choosing a card re-centres the navigator", async ({ page }) => {
  await open(page);
  await pill(page).click();
  await page.locator("[data-kin-step='1'] .hfy-kin__card").click();
  await expect.poll(() => focusId(page)).toBe("K1001");
  await expect(page.locator("[data-tree-focus]")).toHaveAttribute("data-tree-focus", "K1001");
  await expect(panel(page)).toBeVisible();
  await expect(page.locator("[data-kin-sentence]")).toHaveText("Lark Mirren is your father.");
});

test("the 'my grandparents' and 'my cousins' shortcuts re-centre the navigator", async ({ page }) => {
  await open(page);
  await pill(page).click();
  const gp = page.locator("[data-kin-shortcut='grandparents']");
  await gp.click();
  await expect(gp).toHaveAttribute("aria-expanded", "true");
  const list = page.locator("#hfy-kin-grandparents li button");
  await expect(list).toHaveCount(4);
  await list.filter({ hasText: "Jory Tamsin" }).click();
  await expect.poll(() => focusId(page)).toBe("K1013");
  await expect(page.locator("[data-kin-sentence]")).toHaveText("Jory Tamsin is your grandfather.");
  await page.locator("[data-kin-shortcut='cousins']").click();
  await expect(page.locator("#hfy-kin-cousins li button")).toHaveText([/Sorrel Vance/, /Tarn Quill/]);
  await page.locator("#hfy-kin-cousins li button", { hasText: "Tarn Quill" }).click();
  await expect.poll(() => focusId(page)).toBe("K1005");
  await expect(page.locator("[data-kin-sentence]")).toHaveText("Tarn Quill is your first cousin.");
});

test("the viewer's own card says so, and a person with no connection says so in words", async ({ page }) => {
  await open(page, { focus: VIEWER });
  await pill(page).click();
  await expect(page.locator("[data-kin-sentence]")).toHaveText("that's you.");
  await open(page, { focus: "K1030" });
  await pill(page).click();
  await expect(page.locator("[data-kin-sentence]")).toHaveText("Wren Lone isn't connected to you in the tree yet.");
  await expect(page.locator("[data-kin-route]")).toHaveCount(0);
});

test("the pill closes the panel and keeps the keyboard on itself", async ({ page }) => {
  await open(page);
  await pill(page).click();
  await expect(panel(page)).toBeVisible();
  await pill(page).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(pill(page)).toBeFocused();
});

for (const [width, height] of [[375, 812], [768, 1024], [1280, 900]]) {
  test(`D-11 audit at ${width}px with ?hfy_flags=familyVizKinship: axe, 44 px targets, 16 px names, no sideways scroll`, async ({ page }) => {
    await open(page, { width, height, focus: "K1020" });
    await pill(page).click();
    await page.locator("[data-kin-shortcut='cousins']").click();
    await expect(page.locator("#hfy-kin-cousins")).toBeVisible();
    if (process.env.HFY_SHOTS_DIR) {
      mkdirSync(process.env.HFY_SHOTS_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.HFY_SHOTS_DIR}/tree-kinship-${width}.png`, fullPage: true });
    }
    expect(await axeViolations(page)).toEqual([]);
    const small = await page.locator("[data-tree-kin] :is(a, button)").evaluateAll((els) => els
      .filter((e) => e.getClientRects().length)
      .map((e) => ({ t: e.textContent.trim().slice(0, 24), r: e.getBoundingClientRect(), fs: parseFloat(getComputedStyle(e).fontSize), inline: Boolean(e.closest("p")) }))
      .filter((x) => !x.inline && (x.r.height < 44 || x.r.width < 44)));
    expect(small).toEqual([]);
    const names = await page.locator("[data-tree-kin] .hfy-tree__name").evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
    expect(names.length).toBeGreaterThan(0);
    expect(Math.min(...names)).toBeGreaterThanOrEqual(16);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("320: no horizontal page scroll with the panel open", async ({ page }) => {
  await open(page, { width: 320, height: 700, focus: "K1020" });
  await pill(page).click();
  await expect(panel(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
