// HFY-TSK-201: the /tree/ page shell (familyViz). Hermetic: /_data/flags.json, /auth/*, /person/graph.json are route-stubbed with the
// synthetic fixtures/tree-graph-small.json (invented names).
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/tree.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

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
