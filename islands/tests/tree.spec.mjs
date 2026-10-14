// HFY-TSK-201: the /tree/ page shell (familyViz). Hermetic: /_data/flags.json, /auth/*, /person/graph.json are route-stubbed with the
// synthetic fixtures/tree-graph-small.json (invented names).
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/tree.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const GRAPH = readFileSync(new URL("./fixtures/tree-graph-small.json", import.meta.url), "utf8");
const BOUNCE_KEY = "hfy:auth-bounce";

async function stub(page, { shell = false, familyViz = true, graph = { status: 200, body: GRAPH }, sub = "I9003", signedIn = true, refreshOk = true } = {}) {
  const seen = { graph: 0, refresh: 0 };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: shell, familyViz } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: signedIn ? { authenticated: true, sub, label: "Ada Example" } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => { seen.refresh += 1; return r.fulfill({ status: refreshOk ? 200 : 401, json: {} }); });
  await page.route("**/auth/login**", (r) => r.fulfill({ contentType: "text/html", body: "<title>sign in</title><p>sign-in page</p>" }));
  await page.route("**/person/graph.json", (r) => {
    seen.graph += 1;
    const g = typeof graph === "function" ? graph(seen.graph) : graph;
    return r.fulfill({ status: g.status, contentType: "application/json", body: g.body ?? "{}" });
  });
  return seen;
}

const focusName = (page) => page.locator("[data-tree-focus] h2");

test("flag off: the page says the tree is not on and asks for no graph", async ({ page }) => {
  const seen = await stub(page, { familyViz: false });
  await page.goto("/tree/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("h1")).toHaveText("family");
  await expect(page.locator("[data-tree-unavailable]")).toContainText("isn't turned on yet");
  await expect(page.locator("[data-tree-focus]")).toHaveCount(0);
  expect(seen.graph).toBe(0);
});

test("flag on: with no ?focus the page centres on the signed-in member, names the relation and links their page", async ({ page }) => {
  await stub(page);
  await page.goto("/tree/", { waitUntil: "domcontentloaded" });
  await expect(focusName(page)).toHaveText("Ada Example");
  await expect(page.locator("[data-tree-focus]")).toContainText("you");
  await expect(page.locator("[data-tree-focus] a", { hasText: "view page" })).toHaveAttribute("href", "/person/?id=I9003");
  await expect(page.locator("[data-tree-live]")).toHaveText("", { timeout: 1000 }); // nothing is announced on first paint
  expect(new URL(page.url()).searchParams.get("focus")).toBe("I9003");
});

test("?focus wins over the session, shows the relation to the viewer, and re-centring pushes history that Back restores", async ({ page }) => {
  await stub(page);
  await page.goto("/tree/?focus=I9007", { waitUntil: "domcontentloaded" });
  await expect(focusName(page)).toHaveText("Dina Other");
  await expect(page.locator("[data-tree-focus]")).toContainText("your daughter");
  await page.locator("[data-tree-focus] button[data-person='I9005']").click();
  await expect(focusName(page)).toHaveText("Cal Other");
  await expect(focusName(page)).toBeFocused();
  await expect(page.locator("[data-tree-live]")).toContainText("centred on Cal Other");
  expect(page.url()).toContain("focus=I9005");
  await page.goBack();
  await expect(focusName(page)).toHaveText("Dina Other");
  await page.goForward();
  await expect(focusName(page)).toHaveText("Cal Other");
});

test("an unknown ?focus falls back to the viewer with a polite notice, and the address bar agrees", async ({ page }) => {
  await stub(page);
  await page.goto("/tree/?focus=I0000", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-tree-notice]")).toContainText("couldn't find that person");
  await expect(focusName(page)).toHaveText("Ada Example");
  await expect.poll(() => new URL(page.url()).searchParams.get("focus")).toBe("I9003");
});

test("a viewer who is not in the graph lands on the default person", async ({ page }) => {
  await stub(page, { sub: "I8888" });
  await page.goto("/tree/", { waitUntil: "domcontentloaded" });
  await expect(focusName(page)).toHaveText("Gus Example");
  await expect(page.locator("[data-tree-notice]")).toHaveCount(0);
});

test("401: refreshes once, retries once, then signs in with returnTo", async ({ page }) => {
  const seen = await stub(page, { graph: { status: 401, body: JSON.stringify({ error: "unauthenticated" }) } });
  await page.goto("/tree/?focus=I9007", { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/auth\/login\?returnTo=/);
  expect(decodeURIComponent(new URL(page.url()).searchParams.get("returnTo"))).toBe("/tree/?focus=I9007");
  expect(seen.refresh).toBeGreaterThanOrEqual(1);
  expect(seen.graph).toBeLessThanOrEqual(2);
});

test("401 that recovers on the retry renders the tree with no sign-in", async ({ page }) => {
  const seen = await stub(page, { graph: (n) => (n === 1 ? { status: 401, body: "{}" } : { status: 200, body: GRAPH }) });
  await page.goto("/tree/", { waitUntil: "domcontentloaded" });
  await expect(focusName(page)).toHaveText("Ada Example");
  expect(seen.refresh).toBe(1);
  expect(seen.graph).toBe(2);
});

test("401 when this tab was just sent to the sign-in shows the sign-in state instead of looping", async ({ page }) => {
  await page.addInitScript((k) => { try { sessionStorage.setItem(k, String(Date.now())); } catch { /* ignore */ } }, BOUNCE_KEY);
  await stub(page, { graph: { status: 401, body: "{}" }, refreshOk: false });
  await page.goto("/tree/?focus=I9007", { waitUntil: "domcontentloaded" });
  const link = page.locator("[data-tree-state] a", { hasText: "sign in" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "/auth/login?returnTo=%2Ftree%2F%3Ffocus%3DI9007");
});

test("403 and 404 show 'the family tree is being prepared'", async ({ page }) => {
  for (const status of [403, 404]) {
    await stub(page, { graph: { status, body: "<Error/>" } });
    await page.goto("/tree/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-tree-state]")).toHaveText(/the family tree is being prepared/);
    await page.unroute("**/person/graph.json");
  }
});

test("a bad schema shows the retry state; retry loads the tree", async ({ page }) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await stub(page, { graph: (n) => (n === 1 ? { status: 200, body: JSON.stringify({ schemaVersion: 2, people: [], unions: [] }) } : { status: 200, body: GRAPH }) });
  await page.goto("/tree/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-tree-state]")).toContainText("the family tree didn't load. try again.");
  await expect.poll(() => errors.some((e) => e.includes("GRAPH_SCHEMA_UNSUPPORTED"))).toBe(true);
  await page.getByRole("button", { name: "try again" }).click();
  await expect(focusName(page)).toHaveText("Ada Example");
});

test("malformed JSON shows the retry state too", async ({ page }) => {
  await stub(page, { graph: { status: 200, body: "{not json" } });
  await page.goto("/tree/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "try again" })).toBeVisible();
});

test("375px: no sideways scroll, every control at least 44px", async ({ page }) => {
  await stub(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/tree/", { waitUntil: "domcontentloaded" });
  await expect(focusName(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const box of await page.locator("[data-tree-focus] :is(a, button)").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))) {
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
});

test("with the shell on, 'family' is the /tree/ tab and is current there", async ({ page }) => {
  await stub(page, { shell: true });
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.goto("/tree/", { waitUntil: "domcontentloaded" });
  await expect(focusName(page)).toHaveText("Ada Example");
  const family = page.locator('nav[aria-label="primary"] a', { hasText: "family" });
  await expect(family).toHaveAttribute("href", "/tree/");
  await expect(family).toHaveAttribute("aria-current", "page");
});

// ---- HFY-TSK-202: the focus navigator and the generation outline (viz.md 12.1 and 12.3) ----

const outline = (page) => page.locator("nav[aria-label='generations']");

test("structure: focus section with h2, grouped lists of re-centre buttons, one details per generation, a last 'not yet connected' group", async ({ page }) => {
  await stub(page);
  await page.goto("/tree/", { waitUntil: "domcontentloaded" });
  await expect(focusName(page)).toHaveText("Ada Example");
  const focus = page.locator("section[data-tree-focus]");
  await expect(focus).toHaveAttribute("aria-labelledby", "hfy-tree-focus-name");
  await expect(focus.locator("h3")).toHaveText(["parents", "partner and children (1 of 2)", "children (2 of 2)", "brothers and sisters"]);
  await expect(focus.locator("h3 + ul button")).toHaveCount(2 + 3 + 1 + 1);
  await expect(focus.locator("button[data-person='I9001']")).toHaveAccessibleName(/^Gus Example\s*father$/);
  await expect(focus.locator("details > summary")).toHaveCount(0); // gp: none recorded for Ada
  await expect(outline(page).locator("details > summary")).toHaveText([/parents' generation \(2\)/, /Ada's generation \(4\)/, /children's generation \(4\)/, /not yet connected to the tree \(1\)/]);
  await expect(outline(page).locator("details").nth(1)).toHaveAttribute("open", "");
  await expect(outline(page).locator("details").nth(0)).not.toHaveAttribute("open", "");
  await expect(outline(page).locator("details").last().locator("summary")).toContainText("not yet connected");
  // No tree widget, and no tab stop other than the natively focusable controls. (The cards view, <family-navigator>, has its own tab pattern with
  // a roving tabindex: it is what this page adds on top of the outline, not part of it.)
  await expect(page.locator("[role=tree], [role=treeitem], [data-tree-focus] [tabindex]:not([tabindex='-1']), [data-tree-outline] [tabindex]:not([tabindex='-1'])")).toHaveCount(0);
});

test("grandparents are a collapsed fold; the outline re-centres and marks the current person", async ({ page }) => {
  await stub(page);
  await page.goto("/tree/?focus=I9007", { waitUntil: "domcontentloaded" });
  const fold = page.locator("[data-tree-focus] details");
  await expect(fold.locator("summary")).toHaveText("grandparents (2)");
  await expect(fold).not.toHaveAttribute("open", "");
  await outline(page).locator("summary", { hasText: "not yet connected" }).click();
  await outline(page).locator("button[data-person='I9011']").click();
  await expect(focusName(page)).toHaveText("Zed Lone");
  await expect(page.locator("[data-tree-live]")).toContainText("centred on Zed Lone");
  await expect(outline(page).locator("button[data-person='I9011']")).toHaveAttribute("aria-current", "true");
});

test("re-centring through several generations and back keeps the focus level open (automatic toggles are not the reader's)", async ({ page }) => {
  await stub(page);
  await page.goto("/tree/", { waitUntil: "domcontentloaded" });
  const level = (i) => outline(page).locator(`details[data-tree-level='${i}']`);
  await expect(level(1)).toHaveAttribute("open", "");
  await outline(page).locator("summary", { hasText: "parents' generation" }).click();
  await outline(page).locator("details[data-tree-level='0'] button[data-person='I9001']").click();
  await expect(focusName(page)).toHaveText("Gus Example");
  await expect(level(0)).toHaveAttribute("open", "");
  await outline(page).locator("details[data-tree-level='1'] > summary").click();
  await outline(page).locator("details[data-tree-level='1'] button[data-person='I9003']").first().click();
  await expect(focusName(page)).toHaveText("Ada Example");
  await expect(level(1)).toHaveAttribute("open", "");
  await outline(page).locator("details[data-tree-level='0'] button[data-person='I9001']").click();
  await expect(level(0)).toHaveAttribute("open", "");
  await outline(page).locator("details[data-tree-level='1'] button[data-person='I9003']").first().click();
  await expect(level(1)).toHaveAttribute("open", "");
});

test("a level over 20 people shows 20, then 'show N more'", async ({ page }) => {
  const g = JSON.parse(GRAPH);
  const ids = Array.from({ length: 31 }, (_, i) => `I8${String(i).padStart(3, "0")}`);
  for (const id of ids) g.people.push({ id, name: `Pat Synth${id.slice(2)}`, given: "Pat", surname: "Synth", sex: "u", living: false, birthYear: 1950, deathYear: null, yearApprox: false, birthPlace: null, deathPlace: null, generation: 2, component: 0, face: null });
  g.generations[0].levels[2].push(...ids);
  await stub(page, { graph: { status: 200, body: JSON.stringify(g) } });
  await page.goto("/tree/", { waitUntil: "domcontentloaded" });
  const level = outline(page).locator("details[data-tree-level='2']");
  await level.locator("summary").click();
  await expect(level.locator("li")).toHaveCount(20);
  await level.getByRole("button", { name: /^show 15 more/ }).click();
  await expect(level.locator("li")).toHaveCount(35);
});

for (const [width, height] of [[375, 812], [768, 1024], [1280, 900]]) {
  test(`budgets at ${width}px: axe, 44px targets, 16px text, no sideways scroll`, async ({ page }) => {
    await stub(page);
    await page.setViewportSize({ width, height });
    await page.goto("/tree/", { waitUntil: "domcontentloaded" });
    await expect(focusName(page)).toBeVisible();
    for (const d of await outline(page).locator("details").all()) if (!(await d.getAttribute("open"))) await d.locator("summary").first().click();
    expect(await axeViolations(page, { include: ".hfy-tree" })).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const small = await page.locator(".hfy-tree :is(a, button, summary)").evaluateAll((els) => els
      .filter((e) => e.getClientRects().length && getComputedStyle(e).position !== "absolute")
      .map((e) => ({ t: e.textContent.trim().slice(0, 24), r: e.getBoundingClientRect(), fs: parseFloat(getComputedStyle(e).fontSize) }))
      .filter((x) => x.r.height < 44 || x.r.width < 44 || x.fs < 16));
    expect(small).toEqual([]);
  });
}

for (const width of [320, 375]) {
  test(`${width}px: the page never scrolls sideways, even with every generation open`, async ({ page }) => {
    await stub(page);
    await page.setViewportSize({ width, height: 700 });
    await page.goto("/tree/", { waitUntil: "domcontentloaded" });
    await expect(focusName(page)).toBeVisible();
    for (const d of await outline(page).locator("details").all()) if (!(await d.getAttribute("open"))) await d.locator("summary").first().click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("keyboard only: re-centre three times, step back with history, focus lands on the new heading", async ({ page }) => {
  await stub(page);
  await page.goto("/tree/?focus=I9007", { waitUntil: "domcontentloaded" });
  await expect(focusName(page)).toHaveText("Dina Other");
  const hops = [["I9005", "Cal Other"], ["I9003", "Ada Example"], ["I9001", "Gus Example"]];
  for (const [id, name] of hops) {
    const btn = page.locator(`[data-tree-focus] button[data-person='${id}']`);
    await btn.focus();
    await page.keyboard.press("Enter");
    await expect(focusName(page)).toHaveText(name);
    await expect(focusName(page)).toBeFocused();
    await expect(page.locator("[data-tree-live]")).toContainText(`centred on ${name}`);
  }
  await page.goBack();
  await expect(focusName(page)).toHaveText("Ada Example");
  // a summary opens from the keyboard and its people re-centre too
  await outline(page).locator("summary", { hasText: "not yet connected" }).focus();
  await page.keyboard.press("Enter");
  await outline(page).locator("button[data-person='I9011']").focus();
  await page.keyboard.press("Space");
  await expect(focusName(page)).toHaveText("Zed Lone");
});

test("reduced motion: the tree defines no transitions or animations, so nothing moves", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stub(page);
  await page.goto("/tree/", { waitUntil: "domcontentloaded" });
  await expect(focusName(page)).toBeVisible();
  const motion = await page.locator(".hfy-tree *").evaluateAll((els) => els.map((e) => getComputedStyle(e)).filter((c) => parseFloat(c.transitionDuration) > 0 || (c.animationName !== "none" && parseFloat(c.animationDuration) > 0)).length);
  expect(motion).toBe(0);
});

// ---- HFY-TSK-145: the <family-navigator> cards view (viz-mvp-visual), 375px. Synthetic tests/fixtures/tree-graph-messy.json. ----

const MESSY = readFileSync(new URL("./fixtures/tree-graph-messy.json", import.meta.url), "utf8");
const nav = (page) => page.locator("family-navigator");

// A 1x1 WebP, for every face the fixture names.
const PIXEL = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const FACE_OK = (r) => r.fulfill({ status: 200, contentType: "image/webp", body: PIXEL });

async function openCards(page, id = "I8001", opts = {}) {
  await page.route("**/media/faces/**", opts.faces || FACE_OK);
  await stub(page, { graph: { status: 200, body: MESSY }, sub: "I8001", ...opts });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/tree/?focus=${id}`, { waitUntil: "domcontentloaded" });
  await expect(nav(page).locator(".hfy-nav__card--focus .hfy-nav__name")).toHaveText(opts.name || "Robin Quill");
}

/** What the element shows, as plain data: the snapshot the tests compare. */
const snapshot = (page) => nav(page).evaluate((el) => {
  const text = (n, sel) => [...n.querySelectorAll(sel)].map((x) => x.textContent.trim());
  const card = (b) => ({ id: b.dataset.person, name: b.querySelector(".hfy-nav__name").textContent, role: b.querySelector(".hfy-nav__role")?.textContent ?? null, years: b.querySelector(".hfy-nav__years").textContent, badges: text(b, ".hfy-nav__badge"), label: b.getAttribute("aria-label") });
  const focus = el.querySelector(".hfy-nav__card--focus");
  const panel = el.querySelector("[role=tabpanel]");
  return {
    focus: { ...card(focus), place: focus.querySelector(".hfy-nav__place")?.textContent ?? null, face: focus.querySelector("img.hfy-nav__face")?.getAttribute("src") ?? null, initials: focus.querySelector(".hfy-nav__initials")?.textContent ?? null },
    notice: el.querySelector("[data-nav-notice]")?.textContent ?? null,
    parents: [...el.querySelectorAll(".hfy-nav__strip .hfy-nav__card")].map(card),
    parentsLine: [...el.querySelectorAll(".hfy-nav__block")].find((b) => b.querySelector("h3").textContent === "parents").querySelector("p.hfy-nav__none, p.hfy-nav__missing")?.textContent ?? null,
    tabs: text(el, "[role=tab]"),
    selected: el.querySelector("[role=tab][aria-selected=true]")?.textContent ?? null,
    partner: panel?.querySelector(".hfy-nav__partner .hfy-nav__card") ? card(panel.querySelector(".hfy-nav__partner .hfy-nav__card")) : null,
    children: panel ? [...panel.querySelectorAll(".hfy-nav__row .hfy-nav__card")].map(card) : [],
    siblings: [...el.querySelectorAll(".hfy-nav__block")].filter((b) => b.querySelector("h3").textContent === "brothers and sisters").flatMap((b) => [...b.querySelectorAll(".hfy-nav__card")].map(card))
  };
});

test("cards at 375px: the focus card, the parents strip, a tab per union, the children row and the siblings, each part on the page", async ({ page }) => {
  await openCards(page);
  const s = await snapshot(page);
  expect(s.focus).toMatchObject({ id: "I8001", name: "Robin Quill", role: null, years: "1952 to 2020", place: "born in Riverton, Marlow County, Examplestate", face: "/media/faces/I8001-1a2b3c4d.webp", badges: [] });
  expect(s.parents.map((p) => [p.name, p.role, p.years, p.badges])).toEqual([["Sam Quill", "father", "1925 to 1990", []], ["Tess Marlow", "mother", "about 1928 to unknown", ["adopted"]]]);
  expect(s.tabs).toEqual(["with Uma Vale", "with Vic Rowe", "partner not recorded", "partner not recorded"]);
  expect(s.selected).toBe("with Uma Vale");
  expect(s.partner).toMatchObject({ name: "Uma Vale", role: "wife", years: "years unknown" });
  expect(s.children.map((c) => [c.name, c.role, c.badges])).toEqual([["Ada Quill", "daughter", []], ["Ben Quill", "son", ["adopted"]]]);
  expect(s.siblings.map((c) => [c.name, c.role, c.badges])).toEqual([["Pip Quill", "brother", []], ["Kit Quill", "sister", ["half-sibling"]]]);
  expect(s.siblings[1].label).toBe("Kit Quill, half-sister, 1955 to 2001");
  expect(s.notice).toBeNull();
  // the region is labelled, and the page keeps the outline for the same information
  await expect(page.getByRole("region", { name: "family chart centred on Robin Quill. the outline has the same information." })).toBeVisible();
});

test("cards: a tab per union switches the partner and the children; adopted, step and foster are text badges", async ({ page }) => {
  await openCards(page);
  const tabs = nav(page).getByRole("tab");
  await expect(tabs).toHaveCount(4);
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(1)).toBeFocused();
  let s = await snapshot(page);
  expect(s.partner).toMatchObject({ name: "Vic Rowe", role: "partner", years: "about 1951 to unknown" });
  expect(s.children.map((c) => [c.name, c.badges])).toEqual([["Cy Rowe", ["step"]]]);
  await tabs.nth(2).click();
  s = await snapshot(page);
  expect(s.partner).toBeNull(); // 'partner not recorded': no partner card
  expect(s.children.map((c) => [c.name, c.badges])).toEqual([["Dot Fosterly", ["foster"]], ["Eli Sponsor", []], ["Fen Nonrel", []], ["Gus Custom", []], ["Hal Unknown", []]]);
  // arrow keys move between tabs and keyboard focus follows the selected tab (the tab pattern)
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(3)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(3)).toBeFocused();
  s = await snapshot(page);
  expect(s.children.map((c) => c.name)).toEqual(["Ivo Orphaned"]); // the private-excluded partner is absent, not a blank card
});

test("cards: ArrowRight, ArrowLeft, Home and End move the selection and the focus together, two presses in a row included", async ({ page }) => {
  await openCards(page);
  const tabs = nav(page).getByRole("tab");
  await expect(tabs).toHaveCount(4);
  const at = async (i) => {
    await expect(tabs.nth(i)).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(i)).toBeFocused();
    await expect(tabs.nth(i)).toHaveAttribute("tabindex", "0");
  };
  await tabs.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await at(1);
  await page.keyboard.press("ArrowRight"); // the second consecutive press advances again
  await at(2);
  await page.keyboard.press("ArrowLeft");
  await at(1);
  await page.keyboard.press("End");
  await at(3);
  await page.keyboard.press("ArrowRight"); // wraps to the first
  await at(0);
  await page.keyboard.press("End");
  await page.keyboard.press("Home");
  await at(0);
  await page.keyboard.press("ArrowLeft"); // wraps to the last
  await at(3);
});

test("cards: a face crop, or initials in the role colour pair when face is null; a face that fails to load becomes initials", async ({ page }) => {
  await openCards(page, "I8001", { faces: (r) => (r.request().url().includes("/I8002-") ? r.fulfill({ status: 404, body: "" }) : FACE_OK(r)) });
  await expect(nav(page).locator(".hfy-nav__card--focus img.hfy-nav__face")).toHaveAttribute("src", "/media/faces/I8001-1a2b3c4d.webp");
  await expect(nav(page).locator(".hfy-nav__card--focus img")).toHaveAttribute("alt", "");
  // Tess has no face: initials, in her role's colour pair (colours resolve from the tokens, never from a literal)
  const tess = nav(page).locator("button[data-person='I8003'] .hfy-nav__avatar");
  await expect(tess.locator(".hfy-nav__initials")).toHaveText("TM");
  const pair = await tess.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));
  expect(pair.bg).not.toBe("rgba(0, 0, 0, 0)");
  expect(pair.fg).not.toBe(pair.bg);
  // Sam's face 404s: the image is replaced by initials, in the same box
  const sam = nav(page).locator("button[data-person='I8002'] .hfy-nav__avatar");
  await expect(sam.locator(".hfy-nav__initials")).toHaveText("SQ");
  await expect(sam.locator("img")).toHaveCount(0);
});

test("cards: parents not recorded yet, a dashed 'parent not recorded' card for one recorded parent, and a parentless sibling group", async ({ page }) => {
  await openCards(page, "I8002", { name: "Sam Quill" });
  let s = await snapshot(page);
  expect(s.parents).toEqual([]);
  expect(s.parentsLine).toBe("parents not recorded yet");
  expect(s.tabs).toEqual(["with Tess Marlow", "with Una Dale"]);
  await page.goto("/tree/?focus=I8030", { waitUntil: "domcontentloaded" });
  await expect(nav(page).locator(".hfy-nav__card--focus .hfy-nav__name")).toHaveText("Ola Reed");
  s = await snapshot(page);
  expect(s.parents.map((p) => p.name)).toEqual(["Mae Reed"]);
  expect(s.parentsLine).toBe("parent not recorded");
  const missing = nav(page).locator(".hfy-nav__missing");
  await expect(missing).toHaveCSS("border-top-style", "dashed");
  expect(await missing.evaluate((el) => el.tagName !== "BUTTON")).toBe(true); // nothing to open: not a card button
  expect((await missing.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await expect(nav(page).getByRole("tab")).toHaveCount(0);
  await expect(nav(page).locator(".hfy-nav__none")).toContainText("no partner or children recorded yet");
  await page.goto("/tree/?focus=I8040", { waitUntil: "domcontentloaded" });
  await expect(nav(page).locator(".hfy-nav__card--focus .hfy-nav__name")).toHaveText("Ivy Orr");
  s = await snapshot(page);
  expect(s.parentsLine).toBe("parents not recorded yet");
  expect(s.siblings.map((c) => c.name)).toEqual(["Jon Orr", "Kai Orr"]);
});

test("cards: a singleton is 'not yet connected to the tree', with no relative-generation label", async ({ page }) => {
  await openCards(page, "I8050", { name: "Wren Solo" });
  const s = await snapshot(page);
  expect(s.notice).toBe("not yet connected to the tree");
  expect(s.focus.years).toBe("born 1970");
  expect(s.parentsLine).toBe("parents not recorded yet");
  expect(s.tabs).toEqual([]);
  expect(await nav(page).evaluate((el) => /generation/i.test(el.textContent))).toBe(false);
});

test("cards: every person is a <button> named 'name, role, years'; names 16px or more, targets 44px or more", async ({ page }) => {
  await openCards(page);
  const cards = nav(page).locator("button.hfy-nav__card");
  expect(await cards.count()).toBeGreaterThanOrEqual(6);
  await expect(nav(page).locator("button[data-person='I8002']")).toHaveAccessibleName("Sam Quill, father, 1925 to 1990");
  await expect(nav(page).locator("button[data-person='I8001']")).toHaveAccessibleName("Robin Quill, focus, 1952 to 2020, show details");
  for (const label of await cards.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))) expect(label).toMatch(/^.+, .+, .+$/);
  // no card-like element that is not a button, except the placeholder (which has nothing to open)
  expect(await nav(page).locator(".hfy-nav__card:not(button)").count()).toBe(0);
  const small = await nav(page).locator("button, [role=tab]").evaluateAll((els) => els
    .filter((e) => e.getClientRects().length)
    .map((e) => ({ t: e.textContent.trim().slice(0, 24), r: e.getBoundingClientRect(), fs: parseFloat(getComputedStyle(e).fontSize) }))
    .filter((x) => x.r.height < 44 || x.r.width < 44 || x.fs < 16));
  expect(small).toEqual([]);
  const names = await nav(page).locator(".hfy-nav__name").evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
  expect(Math.min(...names)).toBeGreaterThanOrEqual(16);
});

for (const width of [320, 375]) {
  test(`cards at ${width}px: the page never scrolls sideways; the children row scrolls inside itself`, async ({ page }) => {
    await openCards(page);
    await page.setViewportSize({ width, height: 800 });
    await nav(page).getByRole("tab").nth(2).click(); // five children
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const row = nav(page).locator("[role=tabpanel] .hfy-nav__row");
    const m = await row.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, snap: getComputedStyle(el).scrollSnapType, overflow: getComputedStyle(el).overflowX }));
    expect(m.scroll).toBeGreaterThan(m.client);
    expect(m.snap).toContain("x mandatory");
    expect(m.overflow).toBe("auto");
    await row.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollLeft)).toBe(0);
  });
}

test("cards view: axe reports no serious or critical issues at 375px, with each union and the details sheet", async ({ page }) => {
  await openCards(page, "I8001", { shell: true });
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  expect(await axeViolations(page, { include: "family-navigator" })).toEqual([]);
  for (const i of [1, 2, 3]) {
    await nav(page).getByRole("tab").nth(i).click();
    expect(await axeViolations(page, { include: "family-navigator" })).toEqual([]);
  }
  expect(await axeViolations(page, { include: ".hfy-tree" })).toEqual([]);
  await nav(page).locator(".hfy-nav__card--focus").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await axeViolations(page, { include: "[role=dialog]" })).toEqual([]);
});

test("hfy-focus: a card re-centres the page, keeps history and the keyboard, and the polite line says who", async ({ page }) => {
  await openCards(page);
  await nav(page).locator("button[data-person='I8002']").focus();
  await page.keyboard.press("Enter");
  await expect(nav(page).locator(".hfy-nav__card--focus .hfy-nav__name")).toHaveText("Sam Quill");
  await expect(nav(page).locator(".hfy-nav__card--focus")).toBeFocused(); // the keyboard stays on the cards, on the new focus card
  expect(new URL(page.url()).searchParams.get("focus")).toBe("I8002");
  await expect(page.locator("[data-tree-live]")).toContainText("centred on Sam Quill");
  await expect(page.locator("[data-tree-focus] h2")).toHaveText("Sam Quill"); // the plain navigator follows the same focus
  await page.goBack();
  await expect(nav(page).locator(".hfy-nav__card--focus .hfy-nav__name")).toHaveText("Robin Quill");
  // a click works too, and a tab choice resets with the new person
  await nav(page).getByRole("tab").nth(1).click();
  await nav(page).locator("button[data-person='I8022']").click();
  await expect(nav(page).locator(".hfy-nav__card--focus .hfy-nav__name")).toHaveText("Cy Rowe");
  await expect(page.locator("[data-tree-live]")).toContainText("centred on Cy Rowe");
});

test("hfy-details: the focus card opens the kit Sheet with years, places, unions, children and 'view page'; Esc and the close button dismiss it", async ({ page }) => {
  await openCards(page, "I8001", { shell: true });
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveCount(0);
  await expect(nav(page).locator(".io-sheet")).toHaveCount(0); // the element ships no sheet of its own
  const card = nav(page).locator(".hfy-nav__card--focus");
  await card.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Robin Quill");
  await expect(dialog).toContainText("1952 to 2020");
  await expect(dialog).toContainText("Riverton, Marlow County, Examplestate");
  await expect(dialog).toContainText("with Uma Vale");
  await expect(dialog).toContainText("partner not recorded");
  await expect(dialog.locator("a", { hasText: "Ada Quill" })).toHaveAttribute("href", "/person/?id=I8020");
  await expect(dialog.locator("a", { hasText: "view page" })).toHaveAttribute("href", "/person/?id=I8001");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(card).toBeFocused(); // focus returns to the card that opened it
  await card.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "close" }).click();
  await expect(dialog).toHaveCount(0);
  // a tap on any other card re-centres instead
  await nav(page).locator("button[data-person='I8002']").click();
  await expect(dialog).toHaveCount(0);
  await expect(nav(page).locator(".hfy-nav__card--focus .hfy-nav__name")).toHaveText("Sam Quill");
});

test("hfy-details with the shell off (familyViz alone): the sheet still opens, is styled as a dialog and dismisses with Esc and the close button", async ({ page }) => {
  await openCards(page, "I8001", { shell: false });
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  const dialog = page.getByRole("dialog");
  const card = nav(page).locator(".hfy-nav__card--focus");
  await card.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("1952 to 2020");
  // styled: out of the page flow (fixed over the page), not an unstyled block after the cards
  expect(await dialog.evaluate((el) => getComputedStyle(el.closest(".io-sheet") || el).position)).toBe("fixed");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await card.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "close" }).click();
  await expect(dialog).toHaveCount(0);
});

test("cards: a chart chunk that fails to load leaves the outline and the focus navigator working", async ({ page }) => {
  await page.route("**/js/islands/chunks/tree-chart-*.js", (r) => r.abort());
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await stub(page);
  await page.goto("/tree/", { waitUntil: "domcontentloaded" });
  await expect(focusName(page)).toHaveText("Ada Example");
  await expect(outline(page)).toBeVisible();
  await expect(page.locator("family-navigator")).toHaveCount(0);
  await expect(page.locator("[data-tree-chart-failed]")).toHaveText("the chart didn't load. the outline below has everything.");
  await expect.poll(() => errors.some((e) => e.includes("CHART_CHUNK_FAILED"))).toBe(true);
});
