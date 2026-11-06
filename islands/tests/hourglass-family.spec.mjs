// HFY-TSK-379 pass 4: the family page's side of the hourglass tree (flag familyVizHourglass) in a real browser on the invented people of
// fixtures/tree-graph-hourglass.json: the "tree" tab, the "centred on ... / change" chip, the cards' one "see {first} in the tree" link, and
// that with the flag off none of them exists (HFY-R8). Flags, /person/graph.json and the session are route-stubbed; nothing here is real data.
//   PW_CHANNEL=chromium-headless-shell HFY_SITE=<dir> PW_PORT=<free port> npx playwright test tests/hourglass-family.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { CASES, GRAPH } from "./fixtures/hourglass-cases.mjs";

// The site's service worker would answer chunk requests itself, past the route stubs below.
test.use({ serviceWorkers: "block" });

const NAME = Object.fromEntries(GRAPH.people.map((p) => [p.id, p.name]));
const FIRST = (id) => NAME[id].split(" ")[0];
const FLAGS = (o) => ({ authV2: true, shellV2: false, personV2: true, familyViz: true, familyVizHourglass: true, familyVizKinship: false, familyVizTime: true, familyVizBigTree: false, familyVizFaces: false, ...o });

async function stub(page, { flags = {}, sub = "I9002" } = {}) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: FLAGS(flags) }));
  await page.route("**/person/graph.json", (r) => r.fulfill({ status: 200, json: GRAPH }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: sub ? { authenticated: true, sub, grampsId: sub, label: "Sam Example" } : { authenticated: false } }));
  await page.route(/\/person\/I\d+\.json$/, (r) => r.fulfill({ json: {} }));
  await page.route(/\/media\/faces\//, (r) => r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="gray"/></svg>' }));
}

async function open(page, query, { width = 1280, height = 1000, flags = {}, sub } = {}) {
  await page.setViewportSize({ width, height });
  await stub(page, { flags, sub });
  // The "new" mark depends on the date; the tests that look at it fix the clock inside its month.
  await page.clock.setFixedTime(new Date("2026-12-01T12:00:00Z"));
  await page.goto(`/tree/${query}`, { waitUntil: "domcontentloaded" });
}
const ready = async (page) => { await expect(page.locator("[data-tree-focus]")).toBeVisible(); await expect(page.locator("family-navigator [data-person]").first()).toBeVisible(); };
const search = (page) => page.evaluate(() => Object.fromEntries(new URLSearchParams(location.search)));
const views = (page) => page.locator("[data-tree-views] > *").evaluateAll((els) => els.map((e) => `${e.tagName.toLowerCase()}:${e.getAttribute("data-tree-view")}`));

test("flag on: the tree tab is the last tab, a real link to the big tree for the person in front, with a quiet new", async ({ page }) => {
  const id = CASES.full;
  await open(page, `?focus=${id}`);
  await ready(page);
  expect(await views(page)).toEqual(["button:cards", "button:outline", "button:lifelines", "button:table", "a:tree"]);
  const tab = page.locator("[data-tree-views] a[data-tree-view=tree]");
  await expect(tab).toHaveAttribute("href", `/tree/?view=tree&focus=${id}`);
  await expect(tab).toContainText("tree");
  await expect(tab.locator(".hfy-tree__new")).toHaveText("new");
  const box = await tab.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(43.5);
  expect(box.width).toBeGreaterThanOrEqual(43.5);
  await tab.click();
  await expect(page.locator(".hfy-bt")).toBeVisible();
  expect(await search(page)).toEqual({ view: "tree", focus: id });
  await expect(page.locator('.hfy-bt [aria-current="true"]')).toHaveAttribute("aria-label", `${NAME[id]}, in the middle now`);
});

test("the quiet new goes after its month; the tab stays", async ({ page }) => {
  await open(page, `?focus=${CASES.full}`);
  await page.clock.setFixedTime(new Date("2027-03-01T12:00:00Z"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await ready(page);
  await expect(page.locator("[data-tree-views] a[data-tree-view=tree]")).toBeVisible();
  await expect(page.locator(".hfy-tree__new")).toHaveCount(0);
});

test("the tab keeps from= and drops what belongs to other views", async ({ page }) => {
  const id = CASES.full;
  await open(page, `?focus=${id}&view=outline&from=I9005&kin=1&ggp=1`);
  await expect(page.locator("[data-tree-views]")).toBeVisible();
  await expect(page.locator("[data-tree-views] a[data-tree-view=tree]")).toHaveAttribute("href", `/tree/?view=tree&focus=${id}&from=I9005`);
});

test("every tab keeps the person in the address, the chip names them, and the tab follows a re-centre", async ({ page }) => {
  await open(page, "?view=cards", { sub: CASES.siblings });
  await ready(page);
  // no ?focus= in the address to begin with: the page puts the person it shows there
  await expect.poll(() => search(page).then((q) => q.focus)).toBe(CASES.siblings);
  const start = CASES.siblings;
  await expect(page.locator("[data-tree-ctx]")).toContainText(`centred on ${NAME[start]}`);
  for (const v of ["outline", "lifelines", "table", "cards"]) {
    await page.locator(`[data-tree-view=${v}]`).click();
    await expect(page.locator(`[data-tree-view=${v}]`)).toHaveAttribute("aria-pressed", "true");
    expect(await search(page), `view ${v}`).toMatchObject({ view: v, focus: start });
    await expect(page.locator("[data-tree-ctx]")).toContainText(NAME[start]);
  }
  // re-centre from the focus card's list of relatives: the chip and the tab's address move with it
  await ready(page);
  const pick = page.locator("[data-tree-focus] button[data-person]").first();
  const to = await pick.getAttribute("data-person");
  await pick.click();
  await expect(page.locator("[data-tree-ctx]")).toContainText(`centred on ${NAME[to]}`);
  await expect(page.locator("[data-tree-views] a[data-tree-view=tree]")).toHaveAttribute("href", `/tree/?view=tree&focus=${to}`);
  expect((await search(page)).focus).toBe(to);
});

test("change takes the keyboard to the generation outline, which lists everyone and re-centres on a pick", async ({ page }) => {
  await open(page, `?focus=${CASES.full}`);
  await ready(page);
  const change = page.locator("[data-tree-ctx] [data-tree-ctx-change]");
  await expect(change).toHaveText("change");
  const box = await change.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(43.5);
  await change.click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("hfy-tree-outline");
  expect(await page.evaluate(() => location.hash)).toBe("");
});

for (const width of [375, 768, 1280]) {
  test(`the chip sits above the tabs at ${width}: no sideways scroll, 16px text, 44px targets`, async ({ page }) => {
    await open(page, `?focus=${CASES.large}`, { width });
    await ready(page);
    const m = await page.evaluate(() => {
      const chip = document.querySelector("[data-tree-ctx]");
      const views = document.querySelector("[data-tree-views]");
      return { before: Boolean(chip.compareDocumentPosition(views) & Node.DOCUMENT_POSITION_FOLLOWING), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, size: parseFloat(getComputedStyle(chip).fontSize), w: chip.getBoundingClientRect().width, win: innerWidth };
    });
    expect(m.before).toBe(true);
    expect(m.overflow).toBe(false);
    expect(m.size).toBeGreaterThanOrEqual(16);
    expect(m.w).toBeLessThanOrEqual(m.win);
  });
}

test("the cards get one link, see {first} in the tree, to the big tree with from= the same person; the outline view does not", async ({ page }) => {
  const id = CASES.full;
  await open(page, `?focus=${id}`);
  await ready(page);
  const link = page.locator("[data-tree-seetree] a");
  await expect(link).toHaveCount(1);
  await expect(link).toHaveText(`see ${FIRST(id)} in the tree`);
  await expect(link).toHaveAttribute("href", `/tree/?view=tree&focus=${id}&from=${id}`);
  const r = await link.evaluate((a) => { const s = a.querySelector("svg"); const b = a.getBoundingClientRect(); return { h: b.height, svg: [s.getAttribute("width"), s.getAttribute("height"), s.getAttribute("aria-hidden")] }; });
  expect(r.h).toBeGreaterThanOrEqual(43.5);
  expect(r.svg).toEqual(["20", "20", "true"]);
  await page.locator("[data-tree-view=outline]").click();
  await expect(page.locator("[data-tree-seetree]")).toHaveCount(0);
  await page.locator("[data-tree-view=cards]").click();
  await expect(page.locator("[data-tree-seetree] a")).toHaveCount(1);
});

test("the card views with the flag on are the card views with it off, apart from the tab, the chip and the one link", async ({ page, browser }) => {
  const id = CASES.full;
  const dump = async (p, flags) => {
    await open(p, `?focus=${id}`, { flags });
    await ready(p);
    await p.waitForTimeout(150);
    return p.evaluate(() => {
      const root = document.querySelector("[data-island=tree]").cloneNode(true);
      return { html: root.innerHTML, extras: [...root.querySelectorAll("[data-tree-ctx], [data-tree-seetree], a[data-tree-view=tree]")].map((e) => e.tagName.toLowerCase()) };
    });
  };
  const on = await dump(page, {});
  const ctx = await browser.newContext({ baseURL: page.url().split("/tree/")[0], viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" });
  const offPage = await ctx.newPage();
  const off = await dump(offPage, { familyVizHourglass: false });
  await ctx.close();
  expect(off.extras).toEqual([]);
  expect(on.extras.sort()).toEqual(["a", "p", "p"]);
  const [a, b] = await page.evaluate(([x, y]) => {
    const f = (html) => { const d = new DOMParser().parseFromString(`<div id="r">${html}</div>`, "text/html"); d.querySelectorAll("[data-tree-ctx], [data-tree-seetree], a[data-tree-view=tree]").forEach((e) => e.remove()); return d.getElementById("r").innerHTML; };
    return [f(x), f(y)];
  }, [on.html, off.html]);
  expect(a).toBe(b);
});

test("flag off: no tab, no chip, no link, and ?view=tree reads as the cards (HFY-R8)", async ({ page }) => {
  await open(page, `?focus=${CASES.full}&view=tree`, { flags: { familyVizHourglass: false } });
  await ready(page);
  await expect(page.locator("[data-tree-views]")).toBeVisible();
  await expect(page.locator("[data-tree-ctx], [data-tree-seetree], a[data-tree-view=tree], .hfy-bt")).toHaveCount(0);
  expect(await views(page)).toEqual(["button:cards", "button:outline", "button:lifelines", "button:table"]);
});

test("the big tree's top bar carries the chip; it follows a tap; change opens the cards view at the outline", async ({ page }) => {
  const id = CASES.full;
  await open(page, `?view=tree&focus=${id}&from=${id}`, { width: 375 });
  await expect(page.locator('.hfy-bt [aria-current="true"]')).toBeVisible();
  const chip = page.locator(".hfy-bt__top [data-tree-ctx]");
  await expect(chip).toContainText(`centred on ${NAME[id]}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const dad = page.locator('.hfy-bt__canvas button[aria-label$=", father"]');
  const dadName = (await dad.getAttribute("aria-label")).replace(/, father$/, "");
  await dad.click();
  await expect(chip).toContainText(`centred on ${dadName}`);
  const change = chip.locator("[data-tree-ctx-change]");
  const href = await change.getAttribute("href");
  expect(href).toMatch(/^\/tree\/\?focus=I\d+&view=cards#hfy-tree-outline$/);
  const box = await change.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(43.5);
  await change.click();
  await expect(page.locator("[data-tree-focus]")).toBeVisible();
  await expect(page.locator("[data-tree-ctx]")).toContainText(`centred on ${dadName}`);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("hfy-tree-outline");
});
