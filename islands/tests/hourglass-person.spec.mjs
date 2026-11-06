// HFY-TSK-379 pass 2: the small hourglass tree on the person page (flag familyVizHourglass), in a real browser on the invented people of
// fixtures/tree-graph-hourglass.json. Flags, /person/graph.json, the person JSON and media are route-stubbed; nothing here is real data.
//   PW_CHANNEL=chromium-headless-shell HFY_SITE=<dir> PW_PORT=<free port> npx playwright test tests/hourglass-person.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { axeViolations } from "./axe.mjs";
import { CASES, GRAPH } from "./fixtures/hourglass-cases.mjs";

// The site's service worker would answer chunk requests itself, past the route stubs below.
test.use({ serviceWorkers: "block" });

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
const TREE = readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8");
const SHOTS = process.env.HFY_SHOTS || "";
const NAME = Object.fromEntries(GRAPH.people.map((p) => [p.id, p.name]));
const WIDTHS = [320, 375, 768, 1280];
const SEVEN = ["full", "oneParent", "noParents", "large", "siblings", "pedigree", "partners"];

const FLAGS = (o) => ({ authV2: true, shellV2: true, personV2: true, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, familyViz: true, familyVizPersonMini: false, familyVizHourglass: true, chatV1: false, ...o });

/** Stub everything the person page asks for, for the person `id` of the fixture. */
async function stub(page, id, { flags = {}, graph = GRAPH, graphStatus = 200, counts = null, store = null } = {}) {
  const person = { ...PERSON, grampsId: id, handle: `h${id}`, displayName: NAME[id] || "Missing Person", familyTreeMedia: { path: `tree_${id}.svg` } };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: FLAGS(flags) }));
  await page.route("**/person/graph.json", (r) => { if (counts) counts.graph += 1; return r.fulfill({ status: graphStatus, json: graph }); });
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: "I9002", grampsId: "I9002", label: "Sam Example" } }));
  await page.route("**/api/**", (r) => r.fulfill({ json: { thread: { id: "x", topic: "comments", comments: [], reactions: {} } } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route(/\/person\/I\d+\.json$/, (r) => r.fulfill({ json: person }));
  await page.route(/\/media\/tree_I\d+\.svg$/, (r) => { if (counts) counts.svg += 1; return r.fulfill({ contentType: "image/svg+xml", body: TREE }); });
  await page.route(/\/media\/faces\//, (r) => r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="gray"/></svg>' }));
  await page.route(/\/media\/MPHOTO\d\.jpg/, (r) => r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="gray"/></svg>' }));
  if (counts) page.on("request", (r) => { if (/\/js\/islands\/chunks\/(tree-hourglass|hourglass-ui)-/.test(r.url())) counts.chunk += 1; });
  if (store) await page.addInitScript((s) => { for (const [k, v] of Object.entries(s)) { try { localStorage.setItem(k, v); } catch { /* none */ } } }, store);
}

async function open(page, caseName, { width = 375, theme = "dark", height = 900, reduced = false, ...rest } = {}) {
  const id = CASES[caseName];
  await page.setViewportSize({ width, height });
  await stub(page, id, rest);
  if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
  if (process.env.HFY_DEBUG) { page.on("console", (m) => console.log("console", m.type(), m.text())); page.on("pageerror", (e) => console.log("pageerror", e.message)); }
  await page.addInitScript((t) => { try { localStorage.setItem("hfy-theme", t); } catch { /* none */ } }, theme);
  await page.goto(`/person/?id=${id}`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  await expect(page.locator("#person-hero h1")).toHaveText(NAME[id]);
  return id;
}

const tree = (page) => page.locator(".hfy-tree");
const theme = (page, t) => page.evaluate((x) => document.documentElement.setAttribute("data-theme", x), t);
const ready = async (page) => { await expect(tree(page)).toBeVisible(); await expect(tree(page).locator(".hfy-tree__card.is-focus")).toBeVisible(); };

// What a person reads and touches in the tree, measured in the page.
const measure = (page) => page.evaluate(() => {
  const root = document.querySelector(".hfy-tree");
  const out = { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth || root.scrollWidth > root.clientWidth + 1, small: [], targets: [], order: [] };
  const rank = { grandparent: 0, parent: 1, sibling: 2, focus: 2, spouse: 2, child: 3, grandchild: 4 };
  for (const el of root.querySelectorAll("*")) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && parseFloat(getComputedStyle(el).fontSize) < 16) out.small.push(`${el.className} ${getComputedStyle(el).fontSize}: ${el.textContent.trim().slice(0, 20)}`);
    }
  }
  for (const el of root.querySelectorAll("a[href], button")) {
    const r = el.getBoundingClientRect();
    if (r.width && (r.width < 43.5 || r.height < 43.5)) out.targets.push(`${el.className} ${Math.round(r.width)}x${Math.round(r.height)}: ${el.textContent.trim().slice(0, 20)}`);
  }
  for (const el of root.querySelectorAll(".hfy-tree__card, .hfy-tree__face")) {
    const m = /is-(focus|parent|grandparent|sibling|spouse|child|grandchild)/.exec(el.className);
    if (m) out.order.push(rank[m[1]]);
    else if (el.classList.contains("hfy-tree__face")) out.order.push(4);
  }
  return out;
});

for (const width of WIDTHS) {
  for (const c of SEVEN) {
    test(`${c} at ${width}: no sideways scroll, names 16px, targets 44px, reading order, aria-current, in both themes`, async ({ page }) => {
      const id = await open(page, c, { width });
      await ready(page);
      for (const t of ["dark", "light"]) {
        await theme(page, t);
        const m = await measure(page);
        expect(m.overflow, `${t}: sideways scroll`).toBe(false);
        expect(m.small, `${t}: text under 16px`).toEqual([]);
        expect(m.targets, `${t}: targets under 44px`).toEqual([]);
        expect(m.order, `${t}: DOM order is ancestors, the person's row, descendants`).toEqual(m.order.slice().sort((a, b) => a - b));
      }
      const current = tree(page).locator('[aria-current="page"]');
      await expect(current).toHaveCount(1);
      await expect(current).toHaveClass(/is-focus/);
      await expect(current).toHaveAttribute("aria-label", `${NAME[id]}, this person. open the big tree`);
      await expect(current).toHaveAttribute("href", new RegExp(`^/tree/\\?view=tree&focus=${id}&from=${id}$`));
      // every card is a real link (or the ghost's button) with its relationship in the name
      const cards = tree(page).locator("a.hfy-tree__card:not(.is-focus):not(.is-chip)");
      const names = await cards.evaluateAll((els) => els.map((e) => [e.getAttribute("aria-label"), e.getAttribute("href")]));
      expect(names.length).toBeGreaterThan(0);
      for (const [label, href] of names) {
        expect(label, href).toMatch(/^.+, (father|mother|parent|grandfather|grandmother|grandparent|brother|sister|sibling|half .+|husband|wife|spouse|partner|son|daughter|child|grandson|granddaughter|grandchild)/);
        expect(href).toMatch(/^\/person\/\?id=I9\d{3}$/);
      }
    });
  }
}

test("full family: the words, the order and the lines of the board", async ({ page }) => {
  await open(page, "full", { width: 375 });
  await ready(page);
  await expect(tree(page).getByRole("link", { name: "Rowan Alder, father" })).toBeVisible();
  await expect(tree(page).getByRole("link", { name: "Mabry Fennick, grandmother, father's side" })).toBeVisible();
  await expect(tree(page).getByRole("link", { name: "Hugo Larkspur, husband" })).toBeVisible();
  await expect(tree(page).getByRole("link", { name: "Kit Larkspur, grandchild, Orrin's child" })).toBeVisible();
  await expect(tree(page).locator(".hfy-tree__cap")).toHaveText(["father's side", "mother's side"]);
  // connectors: 2 px divs under the cards, never SVG
  expect(await tree(page).locator("svg").count()).toBe(0);
  const lines = await tree(page).locator(".hfy-tree__ln").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return [Math.min(r.width, r.height), cs.position, e.tagName]; }));
  expect(lines.length).toBeGreaterThan(10);
  for (const [w, pos, tag] of lines) { expect(w).toBeCloseTo(2, 0); expect(pos).toBe("absolute"); expect(tag).toBe("I"); }
  // every card has the 2 px edge
  const edges = await tree(page).locator(".hfy-tree__card").evaluateAll((els) => els.map((e) => getComputedStyle(e).borderTopWidth));
  expect(new Set(edges)).toEqual(new Set(["2px"]));
  // the person's row is 1 : 1.4 : 1 in a sunken band, with the person in the middle
  const row = await page.locator(".hfy-tree__band .hfy-tree__row").last().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").map(parseFloat));
  expect(row[1] / row[0]).toBeCloseTo(1.4, 1);
  expect(row[2]).toBeCloseTo(row[0], 0);
  const mid = await tree(page).locator(".is-focus").evaluate((e) => { const r = e.getBoundingClientRect(); return r.left + r.width / 2; });
  const rootBox = await tree(page).boundingBox();
  expect(mid).toBeCloseTo(rootBox.x + rootBox.width / 2, 0);
  // the footer
  await expect(tree(page).getByRole("link", { name: "open the big tree, centred on Tamsin Alder" })).toHaveAttribute("href", /^\/tree\/\?view=tree&focus=I9007&from=I9007$/);
  await expect(tree(page).getByText("prefer a list?")).toBeVisible();
  await expect(tree(page).getByRole("link", { name: "outline" })).toHaveAttribute("href", "/tree/?view=outline&focus=I9007");
  await expect(tree(page).getByRole("link", { name: "table" })).toHaveCount(0); // familyVizTime is off: that view does not exist
});

test("the table link shows only with familyVizTime", async ({ page }) => {
  await open(page, "full", { width: 375, flags: { familyVizTime: true } });
  await ready(page);
  await expect(tree(page).getByRole("link", { name: "table" })).toHaveAttribute("href", "/tree/?view=table&focus=I9007");
});

test("one parent: the known side keeps its caption and two generations; the unknown side has no caption", async ({ page }) => {
  await open(page, "oneParent", { width: 375 });
  await ready(page);
  await expect(tree(page).locator(".hfy-tree__cap")).toHaveText(["mother's side"]);
  await expect(tree(page).locator(".is-ghost").first()).toContainText("father not known yet.");
  await expect(tree(page).locator(".hfy-tree__ln.is-dash").first()).toBeAttached();
});

test("no parents: one dashed card, no grandparent row, 'know who? tell us' shows the thank-you in a polite status", async ({ page }) => {
  await open(page, "noParents", { width: 375 });
  await ready(page);
  await expect(tree(page).locator(".is-grandparent")).toHaveCount(0);
  const ghost = tree(page).locator(".hfy-tree__card.is-ghost");
  await expect(ghost).toHaveCount(1);
  await expect(ghost).toContainText("parents not known yet.");
  expect(await ghost.evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe("dashed");
  await ghost.getByRole("button", { name: "know who? tell us" }).click();
  const status = tree(page).getByRole("status");
  await expect(status).toHaveText("thank you. tell us in the comments on this page, or text J.");
});

test("large family: four children and '+5 more children'; opened, the rest wrap and 'show fewer' folds them", async ({ page }) => {
  await open(page, "large", { width: 375 });
  await ready(page);
  const kids = tree(page).locator(".hfy-tree__card.is-child");
  await expect(kids).toHaveCount(4);
  const more = tree(page).getByRole("button", { name: "+5 more children" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(kids).toHaveCount(9);
  const fewer = tree(page).getByRole("button", { name: "show fewer" });
  await expect(fewer).toHaveAttribute("aria-expanded", "true");
  await expect(fewer).toBeFocused();
  await fewer.click();
  await expect(kids).toHaveCount(4);
  await expect(tree(page).getByRole("button", { name: "+5 more children" })).toBeFocused();
});

test("brothers and sisters: the toggle sits in the band, opens in place, sets aria-expanded and shows the siblings row", async ({ page }) => {
  await open(page, "siblings", { width: 375 });
  await ready(page);
  const band = tree(page).locator(".hfy-tree__band");
  const toggle = band.getByRole("button", { name: "6 brothers and sisters. show them" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(band.locator(".is-sibling")).toHaveCount(0);
  const before = await tree(page).boundingBox();
  await toggle.click();
  const hide = band.getByRole("button", { name: "hide brothers and sisters" });
  await expect(hide).toHaveAttribute("aria-expanded", "true");
  await expect(hide).toBeFocused();
  await expect(band.locator(".is-sibling")).toHaveCount(6);
  expect((await tree(page).boundingBox()).height).toBeGreaterThan(before.height);
  await expect(band.getByRole("link", { name: "Gareth Kestrel, half brother, father's side" })).toBeVisible();
  // the siblings come before the person's row in the band, which is where the order puts them
  const roles = await band.locator(".hfy-tree__card").evaluateAll((els) => els.map((e) => /is-(sibling|focus|spouse)/.exec(e.className)[1]));
  expect(roles.indexOf("focus")).toBeGreaterThan(roles.lastIndexOf("sibling"));
  await hide.click();
  await expect(band.locator(".is-sibling")).toHaveCount(0);
});

test("same ancestors on both sides: the note, the tags and the link to the big tree with the great-grandparents", async ({ page }) => {
  await open(page, "pedigree", { width: 375 });
  await ready(page);
  await expect(tree(page).locator(".hfy-tree__note")).toContainText("Delphine and Everett were sister and brother, so Gideon Eastlake and Ottoline Juniper are on both sides of this family.");
  await expect(tree(page).locator(".hfy-tree__note a")).toHaveText("see them in the big tree");
  await expect(tree(page).locator(".hfy-tree__note a")).toHaveAttribute("href", /view=tree&focus=I9065.*&ggp=1$/);
  await expect(tree(page).locator(".hfy-tree__both")).toHaveText(["both sides", "both sides"]);
  await expect(tree(page).getByRole("link", { name: "Delphine Eastlake, grandmother, father's side, on both sides of the family" })).toBeVisible();
  expect(await tree(page).locator(".hfy-tree__ln.is-rep").count()).toBe(0); // the small tree draws no gold line: the tags say it
});

test("several partners: the first on the right, the second on the left, the rest as 'also with'", async ({ page }) => {
  await open(page, "partners", { width: 375 });
  await ready(page);
  const x = async (name) => (await tree(page).getByRole("link", { name }).boundingBox()).x;
  const first = await x("Alma Pennywell, wife");
  const second = await x("Beatrix Oakley, partner");
  const me = await tree(page).locator(".is-focus").boundingBox();
  expect(first).toBeGreaterThan(me.x);
  expect(second).toBeLessThan(me.x);
  await expect(tree(page).locator(".hfy-tree__also")).toContainText("also with");
  await expect(tree(page).locator(".hfy-tree__chip")).toHaveText(["Cleo Fennick · partner", "Dale Ivorton · partner"]);
  await expect(tree(page).getByRole("link", { name: "Lysander Dunmere, son with Alma" })).toBeVisible();
});

test("grandchildren are 44 px faces with a names line below 600 px, a card row from 600", async ({ page }) => {
  await open(page, "full", { width: 375 });
  await ready(page);
  const faces = tree(page).locator(".hfy-tree__face");
  await expect(faces).toHaveCount(3);
  for (const f of await faces.all()) { const b = await f.boundingBox(); expect([Math.round(b.width), Math.round(b.height)]).toEqual([44, 44]); }
  await expect(tree(page).locator(".hfy-tree__names")).toHaveText("grandchildren: Ivy, Jory and Kit");
  await expect(tree(page).locator(".is-grandchild")).toHaveCount(0);
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(tree(page).locator(".hfy-tree__face")).toHaveCount(0);
  await expect(tree(page).locator(".hfy-tree__card.is-grandchild")).toHaveCount(3);
  await expect(tree(page).locator(".hfy-tree__card.is-grandchild .hfy-tree__wd").first()).toHaveText("granddaughter");
});

test("large family at 768: five grandchild cards and a '+4 more' chip that opens the big tree", async ({ page }) => {
  await open(page, "large", { width: 768 });
  await ready(page);
  await expect(tree(page).locator(".hfy-tree__card.is-grandchild")).toHaveCount(6);
  const chip = tree(page).getByRole("link", { name: "4 more grandchildren. open the big tree" });
  await expect(chip).toHaveText("+4 more");
  await expect(chip).toHaveAttribute("href", /^\/tree\/\?view=tree&focus=I9024&from=I9024$/);
});

test("the tree is as wide as its section but never more than 704 px", async ({ page }) => {
  await open(page, "full", { width: 1280 });
  await ready(page);
  expect((await tree(page).boundingBox()).width).toBeLessThanOrEqual(704.5);
  await expect(tree(page).locator(".hfy-tree__row").first()).toBeVisible();
});

// ---- the tree / cards switch ----
test("the tree/cards switch: tree is the default, cards shows the page as it is with the flag off plus 'see the tree', and the choice is remembered", async ({ page }) => {
  await open(page, "full", { width: 375 });
  await ready(page);
  const bar = page.locator(".hfy-hg__bar");
  const treeBtn = bar.getByRole("button", { name: "tree" });
  const cardsBtn = bar.getByRole("button", { name: "cards" });
  await expect(treeBtn).toHaveAttribute("aria-pressed", "true");
  await expect(cardsBtn).toHaveAttribute("aria-pressed", "false");
  for (const b of [treeBtn, cardsBtn]) { const r = await b.boundingBox(); expect(r.height).toBeGreaterThanOrEqual(43.5); expect(r.width).toBeGreaterThanOrEqual(43.5); expect(await b.locator("svg").evaluate((e) => [e.getAttribute("width"), e.getAttribute("height")])).toEqual(["20", "20"]); }
  await expect(page.locator("#person-family-data")).toBeHidden();
  await expect(page.locator("#person-family-visualization")).toBeHidden();
  await expect(page.locator(".hfy-hg__cards")).toBeHidden();
  await cardsBtn.click();
  await expect(cardsBtn).toHaveAttribute("aria-pressed", "true");
  await expect(tree(page)).toBeHidden();
  await expect(page.locator("#person-family-data")).toBeVisible();
  await expect(page.locator("#person-family-visualization svg")).toHaveCount(1); // mini view off: the Graphviz frame, as the page has it with the flag off
  await expect(page.locator('a[data-tree-link]')).toBeVisible();
  const see = page.getByRole("button", { name: "see the tree" });
  await expect(see).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("hfy:person-family-view"))).toBe("cards");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".hfy-hg__bar").getByRole("button", { name: "cards" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#person-family-data")).toBeVisible();
  await expect(tree(page)).toHaveCount(0); // cards were remembered: the tree is not even loaded until it is asked for
  await page.getByRole("button", { name: "see the tree" }).click();
  await ready(page);
  await expect(page.locator("#person-family-data")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("hfy:person-family-view"))).toBe("tree");
});

test("the switch works with a storage that throws (private window): tree by default, nothing remembered", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } }); });
  await open(page, "full", { width: 375 }).catch(() => null);
  await page.goto("/person/?id=I9007", { waitUntil: "domcontentloaded" });
  await ready(page);
  await page.locator(".hfy-hg__bar").getByRole("button", { name: "cards" }).click();
  await expect(page.locator("#person-family-data")).toBeVisible();
  await page.locator(".hfy-hg__bar").getByRole("button", { name: "tree" }).click();
  await expect(tree(page)).toBeVisible();
});

test("with the card mini view on too, cards shows the mini view (not the frame) and the hourglass wins by default", async ({ page }) => {
  await open(page, "full", { width: 375, flags: { familyVizPersonMini: true } });
  await ready(page);
  await expect(page.locator("[data-person-mini]")).toHaveCount(0); // tree view: the mini view is not drawn at all
  await expect(page.locator("#person-family-visualization svg")).toHaveCount(0);
  await page.locator(".hfy-hg__bar").getByRole("button", { name: "cards" }).click();
  await expect(page.locator("[data-person-mini]")).toBeVisible();
  await expect(page.locator("#person-family-visualization svg")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "see the tree" })).toBeVisible();
});

// ---- the flag off, and the page when the tree cannot be drawn ----
test("flag off: the page is unchanged, with no request for the tree chunks or graph.json", async ({ page }) => {
  const counts = { graph: 0, svg: 0, chunk: 0 };
  await open(page, "full", { width: 375, flags: { familyVizHourglass: false }, counts });
  await expect(page.locator("#person-family-visualization svg")).toHaveCount(1);
  await expect(page.locator(".hfy-hg__bar")).toHaveCount(0);
  await expect(page.locator(".hfy-hg")).toHaveCount(0);
  await expect(page.locator(".hfy-tree")).toHaveCount(0);
  expect(await page.locator("#person-family-section").getAttribute("data-hfy-view")).toBeNull();
  await expect(page.locator("#person-family-data")).toBeVisible();
  await page.waitForTimeout(500);
  expect(counts).toEqual({ graph: 0, svg: 1, chunk: 0 });
});

test("without familyViz the hourglass flag does nothing", async ({ page }) => {
  const counts = { graph: 0, svg: 0, chunk: 0 };
  await open(page, "full", { width: 375, flags: { familyViz: false }, counts });
  await expect(page.locator("#person-family-visualization svg")).toHaveCount(1);
  await page.waitForTimeout(400);
  expect(counts.chunk).toBe(0);
  expect(counts.graph).toBe(0);
  await expect(page.locator(".hfy-hg__bar")).toHaveCount(0);
});

for (const [name, opts] of [
  ["graph.json 404", { graphStatus: 404 }],
  ["graph.json 401 (gated)", { graphStatus: 401 }],
  ["graph.json 500", { graphStatus: 500 }],
  ["the person missing from graph.json", { graph: { ...GRAPH, people: GRAPH.people.filter((p) => p.id !== "I9007") } }],
  ["a person with nobody around them", { alone: true }]
]) {
  test(`${name}: the Graphviz frame appears and no switch is left`, async ({ page }) => {
    const { alone, ...rest } = opts;
    await open(page, alone ? "alone" : "full", { width: 375, ...rest });
    await expect(page.locator("#person-family-visualization")).toBeVisible();
    await expect(page.locator("#person-family-visualization svg")).toHaveCount(1);
    await expect(page.locator(".hfy-hg__bar")).toHaveCount(0);
    await expect(tree(page)).toHaveCount(0);
    expect(await page.locator("#person-family-section").getAttribute("data-hfy-view")).toBeNull();
    await expect(page.locator("#person-family-data")).toBeVisible();
  });
}

test("the chunk failing to load is the same: the frame appears", async ({ page }) => {
  await page.route(/\/js\/islands\/chunks\/tree-hourglass-/, (r) => r.abort());
  await open(page, "full", { width: 375 });
  await expect(page.locator("#person-family-visualization svg")).toHaveCount(1);
  await expect(page.locator(".hfy-hg__bar")).toHaveCount(0);
});

// ---- motion, focus, axe ----
test("reduced motion: every transition and animation of the tree lasts 0 s", async ({ page }) => {
  await open(page, "siblings", { width: 375, reduced: true });
  await ready(page);
  await tree(page).getByRole("button", { name: "6 brothers and sisters. show them" }).click();
  const found = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll(".hfy-tree, .hfy-tree *")) for (const pseudo of [null, "::after"]) {
      const cs = getComputedStyle(el, pseudo);
      for (const d of [...cs.transitionDuration.split(","), ...cs.animationDuration.split(",")]) if (parseFloat(d) !== 0) out.push(`${el.className} ${pseudo || ""} ${d}`);
    }
    return out;
  });
  expect(found).toEqual([]);
});

test("without reduced motion the siblings row and the chevron do animate", async ({ page }) => {
  await open(page, "siblings", { width: 375 });
  await ready(page);
  await tree(page).getByRole("button", { name: "6 brothers and sisters. show them" }).click();
  const d = await page.evaluate(() => [getComputedStyle(document.querySelector(".hfy-tree__row.is-open")).animationDuration, getComputedStyle(document.querySelector(".hfy-tree__tog"), "::after").transitionDuration]);
  expect(d.every((x) => parseFloat(x) > 0)).toBe(true);
});

test("keyboard focus: Tab reaches the cards in reading order and the ring is the system ring (outline not none)", async ({ page }) => {
  await open(page, "full", { width: 375 });
  await ready(page);
  await page.locator(".hfy-hg__bar button").first().focus();
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Tab");
    seen.push(await page.evaluate(() => { const e = document.activeElement; const cs = getComputedStyle(e); return [e.getAttribute("aria-label") || e.textContent.trim().slice(0, 20), cs.outlineStyle, parseFloat(cs.outlineWidth)]; }));
  }
  for (const [, style, w] of seen) { expect(style).not.toBe("none"); expect(w).toBeGreaterThanOrEqual(2); }
  expect(seen.map((s) => s[0])[0]).toBe("cards");
  expect(seen.map((s) => s[0]).slice(1, 3)).toEqual(["Silas Alder, grandfather, father's side", "Mabry Fennick, grandmother, father's side"]);
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineColor);
  expect(ring).not.toBe("rgba(0, 0, 0, 0)");
});

for (const width of [375, 1280]) {
  test(`axe at ${width}: no violations in the tree or the switch, in both themes`, async ({ page }) => {
    await open(page, "partners", { width });
    await ready(page);
    for (const t of ["dark", "light"]) {
      await theme(page, t);
      const v = await axeViolations(page, { include: ".hfy-hg", impacts: ["minor", "moderate", "serious", "critical"] });
      expect(v, t).toEqual([]);
      const bar = await axeViolations(page, { include: ".hfy-hg__bar", impacts: ["minor", "moderate", "serious", "critical"] });
      expect(bar, `${t} switch`).toEqual([]);
    }
  });
}

test("axe with the siblings row opened and the children opened, at 375", async ({ page }) => {
  await open(page, "siblings", { width: 375 });
  await ready(page);
  await tree(page).getByRole("button", { name: "6 brothers and sisters. show them" }).click();
  expect(await axeViolations(page, { include: ".hfy-hg", impacts: ["minor", "moderate", "serious", "critical"] })).toEqual([]);
});

// ---- screenshots for the visual check (HFY_SHOTS=<folder>) ----
test("screenshots: the seven cases at 375, 768 and 1280 in both themes", async ({ page }) => {
  test.skip(!SHOTS, "HFY_SHOTS is the folder the screenshots go in");
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });
  for (const width of [375, 768, 1280]) {
    for (const c of SEVEN) {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await open(page, c, { width, height: 2600 });
      await ready(page);
      if (c === "siblings") await tree(page).getByRole("button", { name: /show them$/ }).click();
      for (const t of ["dark", "light"]) {
        await theme(page, t);
        await page.waitForTimeout(250);
        await page.locator(".hfy-hg").screenshot({ path: `${SHOTS}/${c}-${width}-${t === "dark" ? "dark" : "daylight"}.png` });
      }
    }
  }
});
