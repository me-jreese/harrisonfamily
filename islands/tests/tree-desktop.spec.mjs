// HFY-TSK-299 (viz-mvp-visual-desktop): the Family Card Navigator from 43rem. Hermetic: /_data/flags.json, /auth/*, /person/graph.json and the
// face crops are route-stubbed with the synthetic tests/fixtures/tree-graph-wide.json (invented names; one focus with four grandparent slots,
// five brothers and sisters, three unions and twelve children) and tree-graph-messy.json.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/tree-desktop.spec.mjs
// HFY_SHOTS_DIR=<dir> also saves the 768 and 1280 screenshots (the acceptance evidence).
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const WIDE = readFileSync(new URL("./fixtures/tree-graph-wide.json", import.meta.url), "utf8");
const MESSY = readFileSync(new URL("./fixtures/tree-graph-messy.json", import.meta.url), "utf8");
const PIXEL = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");

async function open(page, { width, height = 1000, id = "I7100", graph = WIDE, sub = "I7100" }) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, familyViz: true } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub, label: "Ada Example" } }));
  await page.route("**/media/faces/**", (r) => r.fulfill({ status: 200, contentType: "image/webp", body: PIXEL }));
  await page.route("**/person/graph.json", (r) => r.fulfill({ status: 200, contentType: "application/json", body: graph }));
  await page.setViewportSize({ width, height });
  await page.goto(`/tree/?focus=${id}`, { waitUntil: "domcontentloaded" });
  await expect(nav(page).locator(".hfy-nav__card--focus")).toBeVisible();
}

const nav = (page) => page.locator("family-navigator");
const band = (page, id) => nav(page).locator(`.hfy-nav__band--${id}`);
const box = async (loc) => (await loc.boundingBox());
const focusCardName = (page) => nav(page).locator(".hfy-nav__card--focus .hfy-nav__name");
const names = (loc) => loc.locator(".hfy-nav__name").allTextContents();
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("1280: four rows (grandparents with a 'not recorded' card, parents, the focus family, children) and the detail panel shows the focus person", async ({ page }) => {
  await open(page, { width: 1280, height: 1100 });
  await expect(nav(page).locator("[data-nav-layout=grid]")).toBeVisible();
  // the four rows, top to bottom
  const ys = [];
  for (const id of ["grandparents", "parents", "family", "children"]) ys.push((await box(band(page, id))).y);
  expect(ys).toEqual([...ys].sort((a, b) => a - b));
  expect(new Set(ys).size).toBe(4);
  // grandparents: up to 4 slots: three recorded and one dashed 'not recorded' card
  expect(await names(band(page, "grandparents"))).toEqual(["Rex Ashby", "Sue Ashby", "Tom Lowell"]);
  await expect(band(page, "grandparents").locator(".hfy-nav__missing")).toHaveText(["grandparent not recorded"]);
  expect(await names(band(page, "parents"))).toEqual(["Pat Ashby", "Quinn Lowell"]);
  await expect(band(page, "grandparents").locator("button[data-person='I7105']")).toHaveAccessibleName("Tom Lowell, grandfather, 1899 to 1970");
  // the focus family: brothers and sisters beside the focus card, the selected partner beside it, on one line
  const focus = await box(nav(page).locator(".hfy-nav__card--focus"));
  const partner = await box(nav(page).locator(".hfy-nav__cell--partner .hfy-nav__card"));
  const firstSib = await box(nav(page).locator(".hfy-nav__cell--sibs .hfy-nav__card").first());
  expect(firstSib.x + firstSib.width).toBeLessThanOrEqual(focus.x);
  expect(partner.x).toBeGreaterThanOrEqual(focus.x + focus.width);
  for (const b of [partner, firstSib]) expect(Math.abs(b.y + b.height / 2 - (focus.y + focus.height / 2))).toBeLessThan(focus.height);
  await expect(nav(page).locator(".hfy-nav__cell--partner .hfy-nav__card .hfy-nav__name")).toHaveText("Una Vale");
  // the other unions are tabs
  await expect(nav(page).getByRole("tab")).toHaveText(["with Una Vale", "with Val Rowe", "partner not recorded"]);
  await expect(nav(page).getByRole("tab", { selected: true })).toHaveText("with Una Vale");
  // the detail panel
  const panel = page.locator("[data-tree-panel='I7100']");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Noel Ashby" })).toBeVisible();
  await expect(panel).toContainText("2 parents");
  await expect(panel).toContainText("2 partners, 12 children");
  await expect(panel).toContainText("that's you");
  await expect(panel).toContainText("born");
  await expect(panel.getByRole("link", { name: "view page" })).toHaveAttribute("href", "/person/?id=I7100");
  await expect(panel.getByRole("link", { name: "Una Vale" })).toHaveAttribute("href", "/person/?id=I7120");
  const p = await box(panel);
  const g = await box(nav(page));
  expect(p.x).toBeGreaterThanOrEqual(g.x + g.width - 1);
  // the page keeps its outline beside the focus navigator, and the generations button belongs to the medium band only
  await expect(page.locator("[data-tree-outline]")).toBeVisible();
  await expect(page.locator("[data-tree-generations]")).toHaveCount(0);
  expect(await noSideways(page)).toBe(true);
});

test("1280: the panel follows the focus; a face crop or initials, and the relation to the viewer", async ({ page }) => {
  await open(page, { width: 1280, height: 1100 });
  const panel = page.locator("[data-tree-panel]");
  await expect(panel.locator("img.hfy-nav__face")).toHaveAttribute("src", "/media/faces/I7100-1a2b3c4d.webp");
  await nav(page).locator("button[data-person='I7101']").click();
  await expect(panel).toHaveAttribute("data-tree-panel", "I7101");
  await expect(panel.getByRole("heading", { name: "Pat Ashby" })).toBeVisible();
  await expect(panel.locator("img")).toHaveCount(0);
  await expect(panel.locator(".hfy-nav__avatar")).toHaveText("PA");
  await expect(panel).toContainText("how you're related: father");
  await expect(panel).toContainText("1 partner, 6 children");
});

test("1280: the focus card moves the keyboard to the panel (no Sheet beside it); below 43rem it still opens the Sheet", async ({ page }) => {
  await open(page, { width: 1280, height: 1100 });
  await nav(page).locator(".hfy-nav__card--focus").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#hfy-tree-panel-name")).toBeFocused();
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(nav(page).locator("[data-nav-layout=stack]")).toBeVisible();
  await expect(page.locator("[data-tree-panel]")).toHaveCount(0);
  await nav(page).locator(".hfy-nav__card--focus").click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("1280: a line wider than its column shows its first cards and '+N more', which expands in place", async ({ page }) => {
  await open(page, { width: 1280, height: 1100 });
  const row = nav(page).locator(".hfy-nav__band--children ul[data-fit]");
  const cards = row.locator(".hfy-nav__item:not([data-more-item])");
  await expect(cards).toHaveCount(9);
  const shown = async () => cards.evaluateAll((els) => els.filter((e) => !e.hidden && e.getClientRects().length).length);
  const first = await shown();
  expect(first).toBeGreaterThan(0);
  expect(first).toBeLessThan(9);
  const more = row.locator("button[data-more]");
  await expect(more).toHaveText(`+${9 - first} more`);
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(more).toHaveAccessibleName(`+${9 - first} more children, with Una Vale`);
  // the shown cards sit inside the column, and the hidden ones are not in the accessibility tree or the tab order
  const r = await box(row);
  for (const c of await cards.evaluateAll((els) => els.filter((e) => !e.hidden).map((e) => e.getBoundingClientRect().toJSON()))) expect(c.right).toBeLessThanOrEqual(r.x + r.width + 1);
  expect(await nav(page).locator("button[data-person='I7138']").count()).toBe(1);
  await expect(nav(page).locator("button[data-person='I7138']")).toBeHidden();
  const before = await box(nav(page).locator(".hfy-nav__band--children"));
  await more.click();
  expect(await shown()).toBe(9);
  await expect(more).toHaveText("show fewer");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(more).toBeFocused();
  expect((await box(nav(page).locator(".hfy-nav__band--children"))).height).toBeGreaterThan(before.height);
  await expect(nav(page).locator("button[data-person='I7138']")).toBeVisible();
  expect(await noSideways(page)).toBe(true);
  await more.click();
  expect(await shown()).toBe(first);
  // a tab switch shows that union's children, not expanded
  await nav(page).getByRole("tab", { name: "with Val Rowe" }).click();
  await expect(nav(page).locator(".hfy-nav__cell--partner .hfy-nav__name")).toHaveText("Val Rowe");
  expect(await names(nav(page).locator(".hfy-nav__band--children"))).toEqual(["Orla Rowe", "Pim Rowe"]);
  await expect(nav(page).locator(".hfy-nav__band--children").getByRole("button", { name: /more|fewer/ })).toHaveCount(0);
  await nav(page).getByRole("tab", { name: "partner not recorded" }).click();
  await expect(nav(page).locator(".hfy-nav__cell--partner .hfy-nav__missing")).toHaveText("partner not recorded");
  expect(await names(nav(page).locator(".hfy-nav__band--children"))).toEqual(["Rue Ashby"]);
});

test("1280: no pan and no zoom: nothing scrolls inside the grid, no transform, no grab cursor, no wheel or pinch handling", async ({ page }) => {
  await open(page, { width: 1280, height: 1100 });
  const m = await nav(page).evaluate((el) => {
    const all = [el, ...el.querySelectorAll("*")];
    const style = (e) => getComputedStyle(e);
    return {
      transformed: all.filter((e) => style(e).transform !== "none").length,
      scrolling: all.filter((e) => /auto|scroll/.test(style(e).overflowX) && e.scrollWidth > e.clientWidth + 1 && e.tagName !== "BUTTON").length,
      grab: all.filter((e) => /grab/.test(style(e).cursor)).length,
      zoom: all.filter((e) => style(e).zoom !== "1" || /pinch|manipulation/.test(style(e).touchAction)).length,
      lineOverflow: [...el.querySelectorAll("ul[data-fit]")].map((u) => style(u).overflowX)
    };
  });
  expect(m).toEqual({ transformed: 0, scrolling: 0, grab: 0, zoom: 0, lineOverflow: expect.arrayContaining(["visible"]) });
  expect(m.lineOverflow.every((o) => o === "visible")).toBe(true);
  const w0 = await box(nav(page));
  await page.mouse.move(w0.x + 50, w0.y + 50);
  await page.mouse.wheel(0, 0);
  await page.keyboard.press("Control+Equal");
  expect((await box(nav(page))).x).toBe(w0.x);
});

for (const [width, height] of [[768, 1024], [1280, 1000], [1920, 1080]]) {
  test(`no name or label renders below 16px at ${width}px, with every row open`, async ({ page }) => {
    await open(page, { width, height });
    for (const more of await nav(page).locator("button[data-more]:visible").all()) await more.click();
    const text = (sel) => page.locator(sel).evaluateAll((els) => els
      .flatMap((e) => [e, ...e.querySelectorAll("*")])
      .filter((e) => e.getClientRects().length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
      .map((e) => ({ t: e.textContent.trim().slice(0, 20), fs: parseFloat(getComputedStyle(e).fontSize) })));
    const grid = await text("family-navigator");
    const panel = await text("[data-tree-panel]");
    expect(grid.length).toBeGreaterThan(30);
    expect(panel.length).toBeGreaterThan(5);
    expect([...grid, ...panel].filter((x) => x.fs < 16)).toEqual([]);
    const nameSizes = await page.locator("family-navigator .hfy-nav__name, [data-tree-panel] .hfy-tree__panel-name").evaluateAll((els) => els.filter((e) => e.getClientRects().length).map((e) => parseFloat(getComputedStyle(e).fontSize)));
    expect(nameSizes.length).toBeGreaterThan(15);
    expect(Math.min(...nameSizes)).toBeGreaterThanOrEqual(16);
    expect(await noSideways(page)).toBe(true);
  });
}

for (const [width, height] of [[768, 1024], [1280, 1000]]) {
  test(`axe at ${width}px: no serious or critical issues, every target at least 44px, with each union and every row open`, async ({ page }) => {
    await open(page, { width, height });
    if (process.env.HFY_SHOTS_DIR) await page.screenshot({ path: `${process.env.HFY_SHOTS_DIR}/tree-desktop-${width}.png`, fullPage: true });
    expect(await axeViolations(page, { include: ".hfy-tree" })).toEqual([]);
    const small = () => page.locator(".hfy-tree :is(a, button, summary, [role=tab])").evaluateAll((els) => els
      .filter((e) => e.getClientRects().length && getComputedStyle(e).position !== "absolute")
      .map((e) => ({ t: e.textContent.trim().slice(0, 24), r: e.getBoundingClientRect(), fs: parseFloat(getComputedStyle(e).fontSize) }))
      .filter((x) => x.r.height < 44 || x.r.width < 44 || x.fs < 16));
    expect(await small()).toEqual([]);
    for (const more of await nav(page).locator("button[data-more]:visible").all()) await more.click();
    for (const i of [1, 2, 0]) {
      await nav(page).getByRole("tab").nth(i).click();
      expect(await axeViolations(page, { include: ".hfy-tree" })).toEqual([]);
      expect(await small()).toEqual([]);
    }
    expect(await noSideways(page)).toBe(true);
  });
}

test("768: two columns (the grid and the detail panel), and the outline opens in the kit Sheet behind a 'generations' button", async ({ page }) => {
  await open(page, { width: 768, height: 1024 });
  await expect(nav(page).locator("[data-nav-layout=grid]")).toBeVisible();
  const g = await box(nav(page));
  const p = await box(page.locator("[data-tree-panel]"));
  expect(p.x).toBeGreaterThanOrEqual(g.x + g.width - 1);
  expect(Math.abs(p.y - g.y)).toBeLessThan(80);
  expect(g.width).toBeGreaterThan(p.width);
  expect(await noSideways(page)).toBe(true);
  // the page's own outline steps aside (it is the Sheet's now)
  await expect(page.locator("[data-tree-outline]")).toBeHidden();
  const button = page.getByRole("button", { name: "generations" });
  await expect(button).toBeVisible();
  expect((await box(button)).height).toBeGreaterThanOrEqual(44);
  await button.click();
  const dialog = page.getByRole("dialog", { name: "generations" });
  await expect(dialog).toBeVisible();
  const inSheet = dialog.getByRole("navigation", { name: "generations in the family" });
  await expect(inSheet.locator("details").first()).toBeVisible();
  await expect(inSheet.locator("details[open] button[data-person='I7110']")).toBeVisible();
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
  expect(await axeViolations(page, { include: "[role=dialog]" })).toEqual([]);
  // Esc closes it and the keyboard comes back to the button
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  // a person picked in the Sheet re-centres the page and closes it
  await button.click();
  await page.getByRole("dialog", { name: "generations" }).locator("button[data-person='I7110']").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(focusCardName(page)).toHaveText("Abe Ashby");
  expect(new URL(page.url()).searchParams.get("focus")).toBe("I7110");
  await expect(page.locator("[data-tree-panel]")).toHaveAttribute("data-tree-panel", "I7110");
  // the outline view (the toggle) keeps the page's own outline at this width, and no button
  await page.getByRole("button", { name: "outline", exact: true }).click();
  await expect(page.locator("[data-tree-outline]")).toBeVisible();
  await expect(page.locator("[data-tree-generations]")).toHaveCount(0);
});

for (const width of [768, 1280]) {
  test(`keyboard only at ${width}px: the cards re-centre three times and the keyboard stays on the new focus card`, async ({ page }) => {
    await open(page, { width, height: 1100 });
    // Noel -> his father -> his father's father -> that man's son (Pat again)
    const hops = [["I7101", "Pat Ashby"], ["I7103", "Rex Ashby"], ["I7101", "Pat Ashby"]];
    for (const [id, name] of hops) {
      const card = nav(page).locator(`button[data-person='${id}']`);
      await card.focus();
      await page.keyboard.press("Enter");
      await expect(focusCardName(page)).toHaveText(name);
      await expect(nav(page).locator(".hfy-nav__card--focus")).toBeFocused();
      await expect(page.locator("[data-tree-live]")).toContainText(`centred on ${name}`);
      await expect(page.locator("[data-tree-panel]")).toHaveAttribute("data-tree-panel", id);
    }
    expect(new URL(page.url()).searchParams.get("focus")).toBe("I7101");
    // Back steps through the same three
    await page.goBack();
    await expect(focusCardName(page)).toHaveText("Rex Ashby");
  });
}

test("keyboard: the '+N more' button is reachable by Tab, opens with Enter and Space, and the tabs keep their arrow keys", async ({ page }) => {
  await open(page, { width: 1280, height: 1100 });
  const more = nav(page).locator(".hfy-nav__band--children button[data-more]");
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(more).toBeFocused();
  await page.keyboard.press("Space");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  const tab = nav(page).getByRole("tab").first();
  await tab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(nav(page).getByRole("tab", { name: "with Val Rowe" })).toBeFocused();
  await expect(nav(page).getByRole("tab", { name: "with Val Rowe" })).toHaveAttribute("aria-selected", "true");
});

test("resizing across 43rem switches layouts and keeps the focus, the union and the keyboard", async ({ page }) => {
  await open(page, { width: 1280, height: 1000 });
  await nav(page).getByRole("tab", { name: "with Val Rowe" }).click();
  await nav(page).getByRole("tab", { name: "with Val Rowe" }).focus();
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(nav(page).locator("[data-nav-layout=stack]")).toBeVisible();
  await expect(focusCardName(page)).toHaveText("Noel Ashby");
  expect(await noSideways(page)).toBe(true);
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(nav(page).locator("[data-nav-layout=grid]")).toBeVisible();
  await expect(nav(page).getByRole("tab", { name: "with Val Rowe" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-tree-generations]")).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(page.locator("[data-tree-generations]")).toHaveCount(0);
  await expect(page.locator("[data-tree-outline]")).toBeVisible();
});

test("1280, messy graph: not-recorded grandparents, no recorded parents, no unions, a person not connected", async ({ page }) => {
  await open(page, { width: 1280, height: 1000, id: "I8001", graph: MESSY, sub: "I8001" });
  // Robin's two parents are recorded and have nobody above them: four dashed cards, no guessed person
  await expect(band(page, "grandparents").locator(".hfy-nav__missing")).toHaveText(Array(4).fill("grandparent not recorded"));
  await expect(band(page, "grandparents").locator("button[data-person]")).toHaveCount(0);
  await expect(nav(page).getByRole("tab")).toHaveCount(4);
  await nav(page).locator("button[data-person='I8002']").click();
  await expect(focusCardName(page)).toHaveText("Sam Quill");
  await expect(band(page, "grandparents")).toContainText("grandparents not recorded yet");
  await expect(band(page, "parents")).toContainText("parents not recorded yet");
  await page.goto("/tree/?focus=I8050", { waitUntil: "domcontentloaded" });
  await expect(focusCardName(page)).toHaveText("Wren Solo");
  await expect(nav(page).locator("[data-nav-notice]")).toHaveText("not yet connected to the tree");
  await expect(band(page, "children")).toContainText("no partner or children recorded yet");
  await expect(nav(page).getByRole("tab")).toHaveCount(0);
  expect(await axeViolations(page, { include: ".hfy-tree" })).toEqual([]);
});
