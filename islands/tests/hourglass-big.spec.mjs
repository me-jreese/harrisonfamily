// HFY-TSK-379 pass 3: the big hourglass tree on /tree/?view=tree (flag familyVizHourglass), in a real browser on the invented people of
// fixtures/tree-graph-hourglass.json. Flags, /person/graph.json, the session and media are route-stubbed; nothing here is real data.
//   PW_CHANNEL=chromium-headless-shell HFY_SITE=<dir> PW_PORT=<free port> npx playwright test tests/hourglass-big.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { axeViolations } from "./axe.mjs";
import { CASES, GRAPH } from "./fixtures/hourglass-cases.mjs";

// The site's service worker would answer chunk requests itself, past the route stubs below.
test.use({ serviceWorkers: "block" });

const SHOTS = process.env.HFY_SHOTS || "";
const NAME = Object.fromEntries(GRAPH.people.map((p) => [p.id, p.name]));
const FIRST = (id) => NAME[id].split(" ")[0];
const WIDTHS = [375, 768, 1100, 1280];
// card width, card height, level names, as hourglass-big.js SIZES
const SIZE = [[48, 48], [128, 184], [168, 232], [208, 264]];
const ID = Object.fromEntries(GRAPH.people.map((p) => [p.name, p.id]));

const FLAGS = (o) => ({ authV2: true, shellV2: false, personV2: true, familyViz: true, familyVizHourglass: true, familyVizKinship: false, familyVizTime: false, familyVizBigTree: false, ...o });

async function stub(page, { flags = {}, sub = "I9002", graph = GRAPH, counts = null } = {}) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: FLAGS(flags) }));
  await page.route("**/person/graph.json", (r) => { if (counts) counts.graph += 1; return r.fulfill({ status: 200, json: graph }); });
  await page.route("**/auth/session", (r) => r.fulfill({ json: sub ? { authenticated: true, sub, grampsId: sub, label: "Sam Example" } : { authenticated: false } }));
  await page.route(/\/person\/I\d+\.json$/, (r) => r.fulfill({ json: {} }));
  await page.route(/\/media\/faces\//, (r) => r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="gray"/></svg>' }));
  if (counts) page.on("request", (r) => { if (/\/js\/islands\/chunks\/(tree-hourglass-big|hourglass-big)-/.test(r.url())) counts.chunk += 1; });
}

/** Open /tree/?view=tree for a case (or an id) and wait for the tree. `query` replaces the address's parameters after view=tree. */
async function open(page, who, { width = 375, height = 900, theme = "dark", reduced = false, query = null, ...rest } = {}) {
  const id = CASES[who] || who;
  await page.setViewportSize({ width, height });
  await stub(page, rest);
  if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
  if (process.env.HFY_DEBUG) { page.on("console", (m) => console.log("console", m.type(), m.text())); page.on("pageerror", (e) => console.log("pageerror", e.message)); }
  await page.addInitScript((t) => { try { localStorage.setItem("hfy-theme", t); } catch { /* none */ } }, theme);
  await page.goto(`/tree/?view=tree${query === null ? `&focus=${id}&from=${id}` : query}`, { waitUntil: "domcontentloaded" });
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  return id;
}
const bt = (page) => page.locator(".hfy-bt");
const stage = (page) => page.locator(".hfy-bt__stage");
const ready = async (page) => { await expect(bt(page)).toBeVisible(); await expect(bt(page).locator('[aria-current="true"]')).toBeVisible(); await page.waitForTimeout(60); };
const theme = (page, t) => page.evaluate((x) => document.documentElement.setAttribute("data-theme", x), t);
const tool = (page, name) => bt(page).getByRole("button", { name, exact: true });
const level = (page) => bt(page).evaluate((e) => Number(e.dataset.level));
const mid = (page) => bt(page).locator('[aria-current="true"]');
/** How far the middle card's centre is from the stage's centre, in px, and the scroll room left on each side. */
const offCentre = (page) => page.evaluate(() => {
  const s = document.querySelector(".hfy-bt__stage").getBoundingClientRect();
  const a = document.querySelector('.hfy-bt [aria-current="true"]').getBoundingClientRect();
  const el = document.querySelector(".hfy-bt__stage");
  return { dx: Math.abs(a.left + a.width / 2 - (s.left + s.width / 2)), dy: Math.abs(a.top + a.height / 2 - (s.top + s.height / 2)), x: el.scrollLeft, y: el.scrollTop, maxX: el.scrollWidth - el.clientWidth, maxY: el.scrollHeight - el.clientHeight };
});
const search = (page) => page.evaluate(() => Object.fromEntries(new URLSearchParams(location.search)));

/** What a person reads and touches in the big tree, measured in the page. */
const measure = (page) => page.evaluate(() => {
  const root = document.querySelector(".hfy-bt");
  const out = { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, small: [], targets: [], tops: [], noLabel: [] };
  for (const el of root.querySelectorAll("*")) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const r = el.getBoundingClientRect();
    if (r.width && r.height && parseFloat(getComputedStyle(el).fontSize) < 16) out.small.push(`${el.className} ${getComputedStyle(el).fontSize}: ${el.textContent.trim().slice(0, 20)}`);
  }
  for (const el of root.querySelectorAll("a[href], button")) {
    const r = el.getBoundingClientRect();
    if (r.width && (r.width < 43.5 || r.height < 43.5)) out.targets.push(`${el.className} ${Math.round(r.width)}x${Math.round(r.height)}: ${el.textContent.trim().slice(0, 20)}`);
  }
  for (const el of root.querySelectorAll(".hfy-bt__canvas .hfy-tree__card")) {
    out.tops.push(parseFloat(el.style.top));
    if (el.tagName === "BUTTON" && !el.getAttribute("aria-label")) out.noLabel.push(el.textContent);
  }
  return out;
});

const SEVEN = ["full", "oneParent", "noParents", "large", "siblings", "pedigree", "partners"];
for (const width of WIDTHS) {
  for (const c of SEVEN) {
    test(`${c} at ${width}: opens centred, no sideways page scroll, names 16px, targets 44px, reading order, in both themes`, async ({ page }) => {
      const id = await open(page, c, { width });
      await ready(page);
      for (const t of ["dark", "light"]) {
        await theme(page, t);
        const m = await measure(page);
        expect(m.overflow, `${t}: sideways scroll of the page`).toBe(false);
        expect(m.small, `${t}: text under 16px`).toEqual([]);
        expect(m.targets, `${t}: targets under 44px`).toEqual([]);
        expect(m.noLabel, `${t}: a card with no accessible name`).toEqual([]);
        expect(m.tops, `${t}: DOM order is ancestors, the person's row, descendants`).toEqual(m.tops.slice().sort((a, b) => a - b));
      }
      await expect(mid(page)).toHaveCount(1);
      await expect(mid(page)).toHaveAttribute("aria-label", `${NAME[id]}, in the middle now`);
      const o = await offCentre(page);
      expect(o.dx < 2 || o.x <= 1 || o.x >= o.maxX - 1, `the person is in the middle across (${JSON.stringify(o)})`).toBe(true);
      expect(o.dy < 2 || o.y <= 1 || o.y >= o.maxY - 1, `and down (${JSON.stringify(o)})`).toBe(true);
    });
  }
}

test("the page never scrolls sideways while the stage scrolls inside its own region", async ({ page }) => {
  await open(page, "large", { width: 375 });
  await ready(page);
  const r = await stage(page).evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ov: getComputedStyle(el).overflowX, page: document.documentElement.scrollWidth, win: document.documentElement.clientWidth }));
  expect(r.sw).toBeGreaterThan(r.cw * 2);
  expect(r.ov).toBe("auto");
  expect(r.page).toBeLessThanOrEqual(r.win);
  await stage(page).evaluate((el) => { el.scrollLeft = 0; });
  expect(await page.evaluate(() => [scrollX, document.documentElement.scrollWidth <= document.documentElement.clientWidth])).toEqual([0, true]);
  // the phone view is full screen: fixed over the page, with the top bar, the toolbar and the bar around the stage
  const box = await bt(page).evaluate((e) => { const c = getComputedStyle(e); const r = e.getBoundingClientRect(); return [c.position, r.left, r.top, r.width, r.height, innerWidth, innerHeight]; });
  expect(box).toEqual(["fixed", 0, 0, 375, 900, 375, 900]);
});

test("full: the words, the lines and the card edges of the board", async ({ page }) => {
  await open(page, "full", { width: 375 });
  await ready(page);
  for (const n of ["Rowan Alder, father", "Delia Birchwood, mother", "Hugo Larkspur, husband", "Wren Larkspur, daughter"]) await expect(bt(page).getByRole("button", { name: n })).toBeAttached();
  await expect(bt(page).locator(".hfy-bt__lab")).toContainText(["grandparents", "parents", "children", "grandchildren"]);
  expect(await bt(page).locator("svg").count()).toBe(0);
  const lines = await bt(page).locator(".hfy-tree__ln").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return [Math.min(r.width, r.height), cs.position, e.tagName]; }));
  expect(lines.length).toBeGreaterThan(10);
  for (const [w, pos, tag] of lines) { expect(w).toBeCloseTo(2, 0); expect(pos).toBe("absolute"); expect(tag).toBe("I"); }
  const edges = await bt(page).locator(".hfy-bt__canvas .hfy-tree__card").evaluateAll((els) => els.map((e) => getComputedStyle(e).borderTopWidth));
  expect(new Set(edges)).toEqual(new Set(["2px"]));
  await expect(bt(page).locator(".hfy-bt__ring").first()).toBeAttached();
});

test("zoom in, zoom out and see all step through the four sizes, never scale, and keep the person in the middle", async ({ page }) => {
  await open(page, "full", { width: 375 });
  await ready(page);
  const cardSize = () => mid(page).evaluate((e) => { const r = e.getBoundingClientRect(); const t = []; for (let n = e; n; n = n.parentElement) t.push(getComputedStyle(n).transform); return { w: Math.round(r.width), h: Math.round(r.height), transforms: [...new Set(t)] }; });
  const check = async (lv) => {
    expect(await level(page)).toBe(lv);
    const c = await cardSize();
    expect([c.w, c.h]).toEqual(SIZE[lv]);
    expect(c.transforms).toEqual(["none"]);
    await expect.poll(async () => { const o = await offCentre(page); return o.dx < 2 || o.x <= 1 || o.x >= o.maxX - 1; }).toBe(true);
  };
  await check(1); // under 700: small
  await tool(page, "zoom in").click(); await check(2);
  await tool(page, "zoom in").click(); await check(3);
  await expect(tool(page, "zoom in")).toHaveAttribute("aria-disabled", "true");
  await tool(page, "zoom in").click({ force: true }); await check(3); // at the limit nothing happens
  await tool(page, "zoom out").click(); await check(2);
  await tool(page, "see all").click(); await check(0);
  await expect(tool(page, "see all")).toHaveAttribute("aria-pressed", "true");
  await expect(tool(page, "zoom out")).toHaveAttribute("aria-disabled", "true");
  // faces only: no names, each card a 48 px circle, the name still in the accessible name
  const face = mid(page);
  await expect(face).toHaveAttribute("aria-label", "Tamsin Alder, in the middle now");
  expect(await bt(page).locator(".hfy-bt__canvas .hfy-tree__nm").count()).toBe(0);
  expect(await face.evaluate((e) => getComputedStyle(e).borderTopLeftRadius)).not.toBe("0px");
  await tool(page, "zoom in").click(); await check(1);
});

test("the starting size is small under 700 and medium from 700", async ({ page }) => {
  await open(page, "full", { width: 699 });
  await ready(page);
  expect(await level(page)).toBe(1);
  await page.goto("about:blank");
  await open(page, "full", { width: 700 });
  await ready(page);
  expect(await level(page)).toBe(2);
});

test("a tap puts that person in the middle, writes ?focus= with a new history entry, names the move and moves keyboard focus; back retraces every step", async ({ page }) => {
  const a = await open(page, "full", { width: 768 });
  await ready(page);
  const len0 = await page.evaluate(() => history.length);
  const rowan = ID["Rowan Alder"];
  await bt(page).getByRole("button", { name: "Rowan Alder, father" }).click();
  await expect(mid(page)).toHaveAttribute("aria-label", "Rowan Alder, in the middle now");
  await expect(mid(page)).toBeFocused();
  expect(await search(page)).toEqual({ view: "tree", focus: rowan, from: a });
  expect(await page.evaluate(() => history.length)).toBe(len0 + 1);
  await expect(bt(page).getByRole("status")).toHaveText("now centred on Rowan");
  await expect(bt(page).locator(".hfy-bt__bar h3")).toHaveText("Rowan Alder");
  await expect(bt(page).getByRole("link", { name: "open Rowan's page" })).toHaveAttribute("href", `/person/?id=${rowan}`);
  // a second tap (at a bigger size), then back twice: the top-left back and the browser's back retrace both
  await tool(page, "zoom in").click();
  await bt(page).getByRole("button", { name: /^Corin Alder, / }).click();
  await expect(mid(page)).toHaveAttribute("aria-label", "Corin Alder, in the middle now");
  expect((await search(page)).focus).toBe(ID["Corin Alder"]);
  expect(await page.evaluate(() => history.length)).toBe(len0 + 2);
  expect(await level(page)).toBe(3);
  await expect(bt(page).locator(".hfy-bt__back")).toHaveAttribute("aria-label", "one step back, to Rowan");
  await bt(page).locator(".hfy-bt__back").click();
  await expect(mid(page)).toHaveAttribute("aria-label", "Rowan Alder, in the middle now");
  expect((await search(page)).focus).toBe(rowan);
  expect(await level(page)).toBe(3);
  await page.goBack();
  await expect(mid(page)).toHaveAttribute("aria-label", `${NAME[a]}, in the middle now`);
  expect((await search(page)).focus).toBe(a);
  await page.goForward();
  await expect(mid(page)).toHaveAttribute("aria-label", "Rowan Alder, in the middle now");
});

test("back to {person} puts the page's person back at the starting size, clears the steps, and is disabled at the start", async ({ page }) => {
  const a = await open(page, "full", { width: 375 });
  await ready(page);
  const back = tool(page, "back to Tamsin");
  await expect(back).toHaveAttribute("aria-disabled", "true");
  await bt(page).getByRole("button", { name: "Rowan Alder, father" }).click();
  await expect(back).not.toHaveAttribute("aria-disabled", "true");
  await tool(page, "zoom in").click();
  await bt(page).getByRole("button", { name: /^Corin Alder, / }).click();
  await expect(mid(page)).toHaveAttribute("aria-label", "Corin Alder, in the middle now");
  expect(await level(page)).toBe(2);
  await back.click();
  await expect(mid(page)).toHaveAttribute("aria-label", `${NAME[a]}, in the middle now`);
  await expect(back).toHaveAttribute("aria-disabled", "true");
  expect(await level(page)).toBe(1);
  expect((await search(page)).focus).toBe(a);
  // the steps are cleared: the top-left back now leaves the tree, for the page the visitor came from
  await expect(bt(page).locator(".hfy-bt__back")).toHaveAttribute("aria-label", "back to Tamsin's page");
  await bt(page).locator(".hfy-bt__back").click();
  await expect(page).toHaveURL(new RegExp(`/person/\\?id=${a}$`));
});

test("with no from, back at the start is the browser's back", async ({ page }) => {
  const a = CASES.full;
  await page.goto("about:blank");
  await open(page, "full", { width: 375, query: `&focus=${a}` });
  await ready(page);
  await expect(bt(page).locator(".hfy-bt__back")).toHaveAttribute("aria-label", "back");
  await bt(page).locator(".hfy-bt__back").click();
  await expect(page).toHaveURL("about:blank");
});

test("great-grandparents: the button shows only with shared ancestors, and draws them once with gold lines and 'both sides' tags", async ({ page }) => {
  await open(page, "full", { width: 768 });
  await ready(page);
  await expect(tool(page, "great-grandparents")).toBeHidden();
  await expect(bt(page).locator(".hfy-bt__lab")).toHaveText(["grandparents", "parents", "children", "grandchildren"]);
  await page.goto("about:blank");
  const id = await open(page, "pedigree", { width: 768 });
  await ready(page);
  const gg = tool(page, "great-grandparents");
  await expect(gg).toBeVisible();
  await expect(gg).toHaveAttribute("aria-pressed", "false");
  await expect(bt(page).getByRole("button", { name: /great-grandfather/ })).toHaveCount(0);
  expect(await bt(page).locator(".hfy-tree__ln.is-rep").count()).toBe(0);
  await expect(bt(page).locator(".hfy-tree__both")).toHaveCount(2); // the two grandparents who are brother and sister
  await gg.click();
  await expect(gg).toHaveAttribute("aria-pressed", "true");
  await expect(bt(page).getByRole("button", { name: "Gideon Eastlake, great-grandfather, on both sides of the family" })).toHaveCount(1); // drawn once
  await expect(bt(page).getByRole("button", { name: /^Ottoline Juniper, great-grandmother/ })).toHaveCount(1);
  expect(await bt(page).locator(".hfy-tree__ln.is-rep").count()).toBeGreaterThan(3); // the gold repeat lines to both children of that union
  await expect(bt(page).locator(".hfy-tree__both")).toHaveCount(4); // the two grandparents and the two great-grandparents
  await expect(bt(page).locator(".hfy-bt__lab")).toContainText(["great-grandparents"]);
  expect((await search(page)).ggp).toBe("1");
  await gg.click();
  expect((await search(page)).ggp).toBeUndefined();
  await expect(bt(page).getByRole("button", { name: /great-grandfather/ })).toHaveCount(0);
  // the small tree's link opens it with them shown
  await page.goto("about:blank");
  await open(page, "pedigree", { width: 768, query: `&focus=${id}&from=${id}&ggp=1` });
  await ready(page);
  await expect(tool(page, "great-grandparents")).toHaveAttribute("aria-pressed", "true");
  await expect(bt(page).getByRole("button", { name: /^Gideon Eastlake, great-grandfather/ })).toHaveCount(1);
  // the great-grandparents are in the address: a reload keeps them
  await page.reload({ waitUntil: "domcontentloaded" });
  await ready(page);
  await expect(bt(page).getByRole("button", { name: /^Gideon Eastlake, great-grandfather/ })).toHaveCount(1);
});

test("brothers and sisters open beside the person and half-siblings hang by dashed lines; '+n more' re-centres on that child", async ({ page }) => {
  await open(page, "siblings", { width: 768 });
  await ready(page);
  const chip = bt(page).getByRole("button", { name: /brothers and sisters\. show them$/ });
  await expect(chip).toHaveAttribute("aria-expanded", "false");
  const before = await bt(page).locator(".hfy-tree__ln.is-dash").count();
  await chip.click();
  await expect(bt(page).locator('[data-k^="sibs"]')).toHaveAttribute("aria-expanded", "true");
  await expect(bt(page).locator('[data-k^="sibs"]')).toBeFocused();
  const row = await bt(page).locator(".hfy-tree__card.is-sibling:not(.is-chip), .hfy-bt__canvas .is-focus").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(row).size).toBe(1); // beside the person: one row
  expect(row.length).toBe(7);
  await expect(bt(page).getByRole("button", { name: /half (brother|sister), father's side$/ }).first()).toBeAttached();
  await expect(bt(page).getByRole("button", { name: /half (brother|sister), mother's side$/ }).first()).toBeAttached();
  expect(await bt(page).locator(".hfy-tree__ln.is-dash").count()).toBeGreaterThan(before);
  await bt(page).locator('[data-k^="sibs"]').click();
  await expect(bt(page).getByRole("button", { name: /half (brother|sister)/ })).toHaveCount(0);
  // a child with more than three grandchildren: two shown and "+n more", which puts that child in the middle
  await page.goto("about:blank");
  await open(page, "large", { width: 768 });
  await ready(page);
  const more = bt(page).getByRole("button", { name: "2 more of Olwen's children. put Olwen in the middle" });
  await expect(more).toHaveText("+2 more");
  await more.click();
  await expect(mid(page)).toHaveAttribute("aria-label", "Olwen Quillon, in the middle now");
  expect((await search(page)).focus).toBe(ID["Olwen Quillon"]);
});

test("a parent's other partners show from medium up, not at small, with the step word", async ({ page }) => {
  await open(page, "partners", { width: 375 });
  await ready(page);
  const others = bt(page).getByRole("button", { name: /, (stepmother|mother's partner|father's partner|stepfather)$/ });
  expect(await level(page)).toBe(1);
  await expect(others).toHaveCount(0);
  await tool(page, "zoom in").click();
  expect(await level(page)).toBe(2);
  expect(await others.count()).toBeGreaterThanOrEqual(2);
  // beside the parents on the parents' row, the father's side to the left and the mother's to the right
  const row = await bt(page).locator(".hfy-bt__canvas .is-spouse, .hfy-bt__canvas .is-parent").evaluateAll((els) => els.map((e) => [e.getAttribute("aria-label").split(", ").slice(1).join(", "), Math.round(e.getBoundingClientRect().top)]));
  const parentsTop = row.find(([w]) => w === "father")[1];
  expect(row.filter(([w, top]) => top === parentsTop && /partner|step/.test(w)).length).toBeGreaterThanOrEqual(2);
  await tool(page, "zoom in").click();
  expect(await others.count()).toBeGreaterThanOrEqual(2);
  await tool(page, "zoom out").click();
  await tool(page, "zoom out").click();
  await expect(others).toHaveCount(0);
});

test("polish: brothers and sisters are not the saturated gold, the text is centred in a tall card, the row names stay in view when the stage scrolls sideways", async ({ page }) => {
  await open(page, "siblings", { width: 768, theme: "dark" });
  await ready(page);
  await bt(page).locator('[data-k^="sibs"]').click();
  const fills = await bt(page).locator(".hfy-bt__canvas .hfy-tree__card").evaluateAll((els) => Object.fromEntries(els.map((e) => [e.className.replace(/hfy-tree__card |is-chip /g, ""), getComputedStyle(e).backgroundColor])));
  const sib = fills["is-sibling"];
  expect(sib, "an opened sibling card exists").toBeTruthy();
  expect(sib).not.toBe(fills["is-parent"]);
  const ch = sib.match(/\d+/g).map(Number); // r, g, b: nothing near the gold's (255, 193, 7)
  expect(Math.max(...ch) - Math.min(...ch), "not a saturated fill").toBeLessThan(60);
  // medium: the name, years and word sit in the middle of the card, not at its top
  const gap = await bt(page).locator(".hfy-bt__canvas .is-parent").first().evaluate((e) => {
    const r = e.getBoundingClientRect();
    const kids = [...e.children].map((k) => k.getBoundingClientRect());
    return { above: Math.min(...kids.map((k) => k.top)) - r.top, below: r.bottom - Math.max(...kids.map((k) => k.bottom)) };
  });
  await expect(bt(page).locator(".hfy-bt__canvas .is-parent .hfy-tree__nm").first()).toHaveText("Alaric Kestrel"); // the card text is real elements, not "[object HTMLSpanElement]"
  await expect(bt(page).locator(".hfy-bt__canvas")).not.toContainText("[object");
  expect(Math.abs(gap.above - gap.below)).toBeLessThan(8);
  // phone: scroll the stage to its far end; the row names are still inside it
  await page.goto("about:blank");
  await open(page, "large", { width: 375 });
  await ready(page);
  const labs = await stage(page).evaluate((s) => {
    s.scrollLeft = s.scrollWidth;
    const r = s.getBoundingClientRect();
    return { max: s.scrollWidth - s.clientWidth, labs: [...document.querySelectorAll(".hfy-bt__lab")].map((l) => { const b = l.getBoundingClientRect(); return b.left >= r.left && b.left < r.left + 40 && b.right <= r.right; }) };
  });
  expect(labs.max).toBeGreaterThan(100);
  expect(labs.labs.length).toBeGreaterThan(2);
  expect(labs.labs.every(Boolean), "every row name is at the stage's left edge").toBe(true);
});

test("from 1100 px the framed tree fills the screen under the page's heading, with no wide empty bands", async ({ page }) => {
  await open(page, "full", { width: 1280, height: 900 });
  await ready(page);
  const m = await page.evaluate(() => {
    const f = document.querySelector(".hfy-bt").getBoundingClientRect();
    const h1 = document.querySelector(".hfy-page h1").getBoundingClientRect();
    return { top: f.top, bottom: f.bottom, h1bottom: h1.bottom, h1: h1.height, vh: innerHeight };
  });
  expect(m.h1).toBeGreaterThan(0); // the page's heading stays
  expect(m.top - m.h1bottom).toBeLessThan(24);
  expect(m.vh - m.bottom).toBeLessThan(48);
});

test("every card is a real button named with the relationship; the ghosts are text with a button to tell us", async ({ page }) => {
  await open(page, "partners", { width: 1280 });
  await ready(page);
  const names = await bt(page).locator(".hfy-bt__canvas button.hfy-tree__card").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  expect(names.length).toBeGreaterThan(8);
  for (const n of names) expect(n).toMatch(/^.+, (in the middle now|(father|mother|parent|grandfather|grandmother|grandparent|great-grand\w+|brother|sister|sibling|half .+|husband|wife|spouse|partner|stepfather|stepmother|step-parent|father's partner|mother's partner|son|daughter|child|grandson|granddaughter|grandchild)\b.*|.* brothers? and sisters?\. show them|hide brothers and sisters|\d+ more of .+)$|^\d+ (brother|sister|brothers|sisters|brothers and sisters)\. show them$/);
  expect(await bt(page).locator(".hfy-bt__canvas a").count()).toBe(0);
  const ghost = bt(page).locator(".is-ghost").first();
  await expect(ghost).toContainText("not known yet.");
  expect(await ghost.evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe("dashed");
  await ghost.getByRole("button", { name: "know who? tell us" }).click();
  await expect(bt(page).getByRole("status")).toHaveText("thank you. tell us in the comments on this page, or text J.");
});

test("faces only: ghosts read '?', chips '+N', and the words are still read aloud", async ({ page }) => {
  await open(page, "siblings", { width: 375 });
  await ready(page);
  await tool(page, "see all").click();
  const ghost = bt(page).locator(".is-ghost").first();
  await expect(ghost).toContainText("?");
  await expect(ghost.locator(".hfy-bt__sr")).toContainText("not known yet");
  await expect(bt(page).locator('[data-k^="sibs"]')).toHaveText("+6");
  await expect(bt(page).locator('[data-k^="sibs"]')).toHaveAttribute("aria-label", "6 brothers and sisters. show them");
});

test("keyboard: Tab follows ancestors, the person's row, descendants; Enter and Space re-centre; + - 0 zoom; Escape goes back", async ({ page }) => {
  const a = await open(page, "full", { width: 768 });
  await ready(page);
  // Tab order = DOM order of the cards
  await bt(page).locator(".hfy-bt__tool.is-all").focus();
  const seen = [];
  for (let i = 0; i < 6; i += 1) { await page.keyboard.press("Tab"); seen.push(await page.evaluate(() => document.activeElement.getAttribute("aria-label"))); }
  const dom = await bt(page).locator(".hfy-bt__canvas button.hfy-tree__card").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  expect(seen.slice(-4)).toEqual(dom.slice(0, 4).length ? seen.slice(-4) : []);
  const idxOfFirst = dom.indexOf(seen[seen.length - 4]);
  expect(idxOfFirst).toBeGreaterThanOrEqual(0);
  for (let i = 0; i < 4; i += 1) expect(dom[idxOfFirst + i]).toBe(seen[seen.length - 4 + i]);
  // Enter on a card
  await bt(page).getByRole("button", { name: "Rowan Alder, father" }).focus();
  await page.keyboard.press("Enter");
  await expect(mid(page)).toHaveAttribute("aria-label", "Rowan Alder, in the middle now");
  await expect(mid(page)).toBeFocused();
  // + - 0
  expect(await level(page)).toBe(2);
  await page.keyboard.press("+"); expect(await level(page)).toBe(3);
  await page.keyboard.press("-"); await page.keyboard.press("-"); expect(await level(page)).toBe(1);
  await page.keyboard.press("0"); expect(await level(page)).toBe(0);
  // Space on a card
  await bt(page).getByRole("button", { name: /, (son|daughter|child)$/ }).first().focus();
  await page.keyboard.press("Space");
  await expect(mid(page)).not.toHaveAttribute("aria-label", "Rowan Alder, in the middle now");
  // Escape retraces
  await page.keyboard.press("Escape");
  await expect(mid(page)).toHaveAttribute("aria-label", "Rowan Alder, in the middle now");
  await page.keyboard.press("Escape");
  await expect(mid(page)).toHaveAttribute("aria-label", `${NAME[a]}, in the middle now`);
});

test("the system focus ring is kept on cards and tools", async ({ page }) => {
  await open(page, "full", { width: 768 });
  await ready(page);
  await bt(page).getByRole("button", { name: "Rowan Alder, father" }).focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  for (const [sel, w] of [[".hfy-bt__canvas .is-parent", "2px"], [".hfy-bt__tool.is-all", "2px"]]) {
    await bt(page).locator(sel).first().focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const ring = await bt(page).locator(sel).first().evaluate((e) => { const c = getComputedStyle(e); return [c.outlineStyle, c.outlineWidth, c.outlineOffset]; });
    expect(ring, sel).toEqual(["solid", w, "2px"]);
  }
});

test("reduced motion: no cross-fade, the scroll jumps", async ({ page }) => {
  await open(page, "full", { width: 375, reduced: true });
  await ready(page);
  expect(await stage(page).evaluate((e) => getComputedStyle(e).scrollBehavior)).toBe("auto");
  await bt(page).getByRole("button", { name: "Rowan Alder, father" }).click();
  const fade = await bt(page).locator(".hfy-bt__canvas").evaluate((e) => getComputedStyle(e).animationDuration);
  expect(fade).toBe("0s");
  const o = await offCentre(page); // at once, no easing
  expect(o.dx < 2 || o.x <= 1 || o.x >= o.maxX - 1).toBe(true);
});

test("motion allowed: the re-centre cross-fades in 200 ms", async ({ page }) => {
  await open(page, "full", { width: 375 });
  await ready(page);
  await bt(page).getByRole("button", { name: "Rowan Alder, father" }).click();
  expect(await bt(page).locator(".hfy-bt__canvas").evaluate((e) => getComputedStyle(e).animationDuration)).toBe("0.2s");
});

test("bar under the stage below 1100, panel beside it from 1100", async ({ page }) => {
  await open(page, "full", { width: 1099 });
  await ready(page);
  const geo = () => page.evaluate(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const b = r(".hfy-bt__bar"); const s = r(".hfy-bt__stage"); return { barTop: b.top, stageBottom: s.bottom, barLeft: b.left, stageLeft: s.left, barW: b.width, pane: document.querySelector(".hfy-bt").classList.contains("is-pane"), size: getComputedStyle(document.querySelector(".hfy-bt__size")).display }; });
  let g = await geo();
  expect(g.pane).toBe(false);
  expect(g.barTop).toBeGreaterThanOrEqual(g.stageBottom - 1);
  expect(g.size).toBe("none");
  await expect(bt(page).locator(".hfy-bt__help")).toHaveCount(0);
  await expect(bt(page).locator(".hfy-bt__see span")).toHaveText("see this as");
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(bt(page)).toHaveClass(/is-pane/);
  g = await geo();
  expect(g.barLeft).toBeLessThan(g.stageLeft);
  expect(Math.round(g.barW)).toBe(320);
  expect(g.size).not.toBe("none");
  await expect(bt(page).locator(".hfy-bt__size")).toHaveText("size: medium");
  await expect(bt(page).locator(".hfy-bt__see span")).toHaveText("see this family as");
  await expect(bt(page).locator(".hfy-bt__help")).toHaveText("tap someone to put them in the middle. the buttons zoom. the back button takes you to who you had before.");
  expect(await bt(page).evaluate((e) => getComputedStyle(e).position)).toBe("relative");
  const sz = await bt(page).locator(".hfy-bt__bar .hfy-tree__av").evaluate((e) => Math.round(e.getBoundingClientRect().width));
  expect(sz).toBe(72);
  await tool(page, "zoom in").click();
  await expect(bt(page).locator(".hfy-bt__size")).toHaveText("size: large");
  // the redraw for the new width kept the person and the size
  expect(await level(page)).toBe(3);
});

test("the links in the bar exist only for views the visitor has: cards and outline always; poster, table and 'how are we related?' by flags", async ({ page }) => {
  const POSTER = { ...GRAPH, layout: { engine: "x", params: { nodeSize: [180, 90] }, components: [{ component: 0, width: 300, height: 200, people: [{ id: CASES.full, x: 50, y: 50 }] }] } };
  const a = CASES.full;
  const links = async () => bt(page).locator(".hfy-bt__see a").evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute("href")]));
  await open(page, "full", { width: 1280 });
  await ready(page);
  expect(await links()).toEqual([["cards", `/tree/?view=cards&focus=${a}`], ["outline", `/tree/?view=outline&focus=${a}`]]);
  await expect(bt(page).getByRole("link", { name: "how are we related?" })).toHaveCount(0);
  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await open(page, "full", { width: 1280, flags: { familyVizTime: true, familyVizBigTree: true, familyVizKinship: true }, graph: POSTER });
  await ready(page);
  expect(await links()).toEqual([["cards", `/tree/?view=cards&focus=${a}`], ["the whole-family poster", `/tree/?view=family&focus=${a}`], ["outline", `/tree/?view=outline&focus=${a}`], ["table", `/tree/?view=table&focus=${a}`]]);
  await expect(bt(page).getByRole("link", { name: "how are we related?" })).toHaveAttribute("href", `/tree/?view=cards&focus=${a}&kin=1`);
  await expect(bt(page).getByRole("link", { name: "open Tamsin's page" })).toHaveAttribute("href", `/person/?id=${a}`);
  // the poster needs a layout block in the graph; "how are we related?" a signed-in member who is in the graph
  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await open(page, "full", { width: 1280, flags: { familyVizTime: true, familyVizBigTree: true, familyVizKinship: true }, sub: null });
  await ready(page);
  expect((await links()).map((l) => l[0])).toEqual(["cards", "outline", "table"]);
  await expect(bt(page).getByRole("link", { name: "how are we related?" })).toHaveCount(0);
  // and not on a phone, where the poster is not a view
  await page.goto("about:blank");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await open(page, "full", { width: 375, flags: { familyVizBigTree: true }, graph: POSTER });
  await ready(page);
  expect((await links()).map((l) => l[0])).toEqual(["cards", "outline"]);
});

test("'how are we related?' opens the relationship panel for this person", async ({ page }) => {
  const a = CASES.full;
  await open(page, "full", { width: 375, flags: { familyVizKinship: true }, sub: CASES.noParents });
  await ready(page);
  await bt(page).getByRole("link", { name: "how are we related?" }).click();
  await expect(page).toHaveURL(new RegExp(`view=cards&focus=${a}&kin=1$`));
  await expect(page.locator("[data-kin-panel]")).toBeVisible();
  // the panel is about the person in the middle, not about the visitor (who is another person)
  await expect(page.locator("[data-kin-panel]")).toContainText(NAME[a]);
});

test("flag off: ?view=tree is an unknown view and the page is what it always was", async ({ page }) => {
  const counts = { graph: 0, chunk: 0 };
  await open(page, "full", { width: 1280, flags: { familyVizHourglass: false }, counts });
  await expect(page.locator("[data-tree-views]")).toBeVisible();
  await expect(page.locator(".hfy-tree--ready")).toHaveAttribute("data-tree-mode", "cards");
  await expect(bt(page)).toHaveCount(0);
  expect(counts.chunk).toBe(0);
  expect(await search(page)).toMatchObject({ view: "tree" });
});

test("a big tree chunk that will not load drops the page to the cards, with a line that says so", async ({ page }) => {
  await page.route(/\/js\/islands\/chunks\/tree-hourglass-big-/, (r) => r.abort());
  await open(page, "full", { width: 768 });
  await expect(page.locator("[data-tree-hourglass-failed]")).toHaveText("the big tree didn't load. the cards below have everyone.");
  await expect(page.locator("[data-tree-views]")).toBeVisible();
  await expect(bt(page)).toHaveCount(0);
});

test("a big tree chunk that throws while it draws drops the page to the cards too, with the same line", async ({ page }) => {
  await page.route(/\/js\/islands\/chunks\/tree-hourglass-big-/, (r) => r.fulfill({ contentType: "text/javascript", body: 'export function mountBig() { throw new Error("synthetic draw failure"); }' }));
  await open(page, "full", { width: 768 });
  await expect(page.locator("[data-tree-hourglass-failed]")).toHaveText("the big tree didn't load. the cards below have everyone.");
  await expect(page.locator("[data-tree-views]")).toBeVisible();
  await expect(bt(page)).toHaveCount(0);
});

test("an unknown or merged-away id falls back as the tree page does, with the line that says so", async ({ page }) => {
  await open(page, "full", { width: 768, query: "&focus=I0000&from=I0000" });
  await ready(page);
  await expect(bt(page).getByRole("status")).toHaveText("we couldn't find that person, so here is someone to start from.");
  expect((await search(page)).focus).not.toBe("I0000");
});

test("axe at 375 and 1280 finds nothing", async ({ page }) => {
  for (const width of [375, 1280]) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await open(page, "partners", { width });
    await ready(page);
    await bt(page).locator('[data-k^="sibs"]').click();
    for (const t of ["dark", "light"]) {
      await theme(page, t);
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished))); // the cross-fade is done: axe reads the settled colours
      expect(await axeViolations(page, { include: ".hfy-bt", impacts: ["minor", "moderate", "serious", "critical"] }), `${width} ${t}`).toEqual([]);
    }
  }
});

test.describe("screenshots", () => {
  test("big tree screenshots: four cases, four widths, both themes", async ({ page }) => {
    test.skip(!SHOTS, "HFY_SHOTS is the folder the screenshots go in");
    test.setTimeout(300_000);
    mkdirSync(SHOTS, { recursive: true });
    const cases = { partners: {}, full: {}, pedigree: { tall: true, query: `&focus=${CASES.pedigree}&from=${CASES.pedigree}&ggp=1` }, siblings: { open: "sibs" }, large: { tall: true } };
    for (const width of WIDTHS) {
      for (const [c, o] of Object.entries(cases)) {
        await page.unrouteAll({ behavior: "ignoreErrors" });
        await open(page, c, { width, height: o.tall ? 1500 : width >= 1100 ? 900 : 812, query: o.query });
        await ready(page);
        if (o.open) await bt(page).locator('[data-k^="sibs"]').click();
        for (const t of ["dark", "light"]) {
          await theme(page, t);
          await page.waitForTimeout(300);
          await page.screenshot({ path: `${SHOTS}/big-${c}-${width}-${t === "dark" ? "dark" : "daylight"}.png` });
        }
      }
    }
  });
});
