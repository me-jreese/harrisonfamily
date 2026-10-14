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
  await expect(focus.locator("button[data-person='I9001']")).toHaveAccessibleName("Gus Example, father");
  await expect(focus.locator("details > summary")).toHaveCount(0); // gp: none recorded for Ada
  await expect(outline(page).locator("details > summary")).toHaveText([/parents' generation \(2\)/, /Ada's generation \(4\)/, /children's generation \(4\)/, /not yet connected to the tree \(1\)/]);
  await expect(outline(page).locator("details").nth(1)).toHaveAttribute("open", "");
  await expect(outline(page).locator("details").nth(0)).not.toHaveAttribute("open", "");
  await expect(outline(page).locator("details").last().locator("summary")).toContainText("not yet connected");
  await expect(page.locator("[role=tree], [role=treeitem], [tabindex]:not([tabindex='-1'])")).toHaveCount(0);
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
    await outline(page).locator("summary").first().click();
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

test("reduced motion: nothing animates or transitions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stub(page);
  await page.goto("/tree/", { waitUntil: "domcontentloaded" });
  await expect(focusName(page)).toBeVisible();
  const motion = await page.locator(".hfy-tree *").evaluateAll((els) => els.map((e) => getComputedStyle(e)).filter((c) => parseFloat(c.transitionDuration) > 0 || (c.animationName !== "none" && parseFloat(c.animationDuration) > 0)).length);
  expect(motion).toBe(0);
});
