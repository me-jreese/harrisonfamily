// HFY-TSK-427 (flag lifeStateV1, display only): every surface that said "living" or an age says "status unknown" for a person whose state is unknown,
// at 390 and 1280. Three synthetic people: OLD (no death, born 1920, no evidence), NOBIRTH (no death, no birth year) and ACTIVE (born 1920, a member
// who contributed 30 days ago, so still living). /auth, /api, the flags file, the person JSON, the search corpus and graph.json are stubbed.
// Run: PW_PORT=<port> npx playwright test tests/life-state-surfaces.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const BASE = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
const OLD = "I9101", NOBIRTH = "I9102", ACTIVE = "I9103", GONE = "I9104";
const recent = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
const EVIDENCE = { asOf: recent, evidence: [{ person: ACTIVE, at: recent }], confirmed: [] };
const rel = (id, name, birth, isLiving = true) => ({ handle: `h${id}`, grampsId: id, displayName: name, isLiving, lifespan: { birth: birth ? { year: birth } : {}, death: {} } });
const PERSON = {
  ...BASE, grampsId: OLD, handle: `h${OLD}`, displayName: "Old Example", isLiving: true, lifespan: { birth: { year: 1920 }, death: {} }, notes: [],
  familyTree: { parentFamilies: [], spouseFamilies: [{ father: rel(NOBIRTH, "Nobirth Example", null), mother: rel(ACTIVE, "Active Example", 1920), children: [] }] }
};
const MANIFEST = { people: [
  { grampsId: OLD, displayName: "Old Example", isLiving: true, lifespanSummary: "b. 1920", primaryPhoto: null },
  { grampsId: NOBIRTH, displayName: "Nobirth Example", isLiving: true, lifespanSummary: "", primaryPhoto: null },
  { grampsId: ACTIVE, displayName: "Active Example", isLiving: true, lifespanSummary: "b. 1920", primaryPhoto: null },
  { grampsId: GONE, displayName: "Gone Example", isLiving: false, lifespanSummary: "1850 – 1920", primaryPhoto: null }
] };
const gp = (id, name, living, birthYear, deathYear) => ({ id, name, given: name.split(" ")[0], surname: "Example", sex: "f", living, birthYear, deathYear, yearApprox: false, birthPlace: null, deathPlace: null, generation: 0, component: 0, face: null });
const GRAPH = { schemaVersion: 1, minor: 0, generatedAt: "2026-01-01T00:00:00Z", counts: { people: 4 }, people: [
  gp(OLD, "Old Example", true, 1920, null), gp(NOBIRTH, "Nobirth Example", true, null, null), gp(ACTIVE, "Active Example", true, 1920, null), gp(GONE, "Gone Example", false, 1850, 1920)
], unions: [], edges: [], generations: [] };
const VIEWPORTS = [["390", { width: 390, height: 844 }], ["1280", { width: 1280, height: 800 }]];

async function stub(page, { on = true, evidence = EVIDENCE, lifeStatus = 200 } = {}) {
  const seen = { lifeState: 0 };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: false, profileLinks: false, familyViz: true, lifeDatesV1: true, lifeStateV1: on } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: "I9999", grampsId: "I9999", label: "Sam Example" } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { id: "I9999", label: "Sam Example", admin: false, can: {} } }));
  await page.route("**/api/life-state", (r) => { seen.lifeState += 1; return r.fulfill({ status: lifeStatus, json: lifeStatus === 200 ? evidence : { error: "boom" } }); });
  await page.route("**/api/records/Person/by-id/*", (r) => r.fulfill({ json: { handle: `h${OLD}` } }));
  await page.route(/\/api\/life-dates(\?|$)/, (r) => r.fulfill({ json: { birth: { class: "year", year: 1920 }, death: { class: "none", year: null }, livingByRule: true, sharedEvent: { birth: false, death: false } } }));
  await page.route(`**/person/${OLD}.json`, (r) => r.fulfill({ json: PERSON }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: MANIFEST }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: MANIFEST.people.map((p) => ({ grampsId: p.grampsId, searchText: p.displayName.toLowerCase() })) } }));
  await page.route("**/person/graph.json", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(GRAPH) }));
  await page.route("**/media/tree_I9001.svg", (r) => r.fulfill({ contentType: "image/svg+xml", body: readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8") }));
  return seen;
}
const noSideways = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
const meta = (page, name) => page.locator(".hfy-search__row", { hasText: name }).locator(".hfy-search__meta");

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("person page: header, family list and life dates line say status unknown; an active member stays living; axe and scroll clean", async ({ page }) => {
      const seen = await stub(page);
      await page.goto(`/person/?id=${OLD}`, { waitUntil: "domcontentloaded" });
      const header = page.locator("#person-hero .person-lifespan");
      await expect(header).toContainText("born 1920 · status unknown");
      await expect(header).not.toContainText("living");
      await expect(header.getByRole("link", { name: "help fill in" })).toHaveAttribute("href", "/me/dates/");
      const items = page.locator("#person-family-data .family-member");
      await expect(items.filter({ hasText: "Nobirth Example" })).toContainText("birth year unknown");
      await expect(items.filter({ hasText: "Active Example" })).toContainText("living");
      await expect(page.locator("#person-family-data")).not.toContainText("status unknown");
      await expect(page.locator('#person-hero [data-ld="line"]')).toHaveText("born 1920 · status unknown");
      expect(seen.lifeState, "one read of the evidence per page load").toBe(1);
      await noSideways(page);
      expect(await axeViolations(page)).toEqual([]);
    });

    test("person page: flag off is today's text and asks for nothing", async ({ page }) => {
      const seen = await stub(page, { on: false });
      await page.goto(`/person/?id=${OLD}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("#person-hero .person-lifespan")).toHaveText("1920 · living");
      await expect(page.locator("#person-family-data .family-member").filter({ hasText: "Active Example" })).toContainText("living");
      await expect(page.locator('#person-hero [data-ld="line"]')).toHaveText("born 1920 · date of death unknown");
      expect(await page.locator("body").innerText()).not.toContain("status unknown");
      expect(seen.lifeState).toBe(0);
    });

    test("person page: a failed evidence read fails closed to status unknown", async ({ page }) => {
      await stub(page, { lifeStatus: 500 });
      await page.goto(`/person/?id=${OLD}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("#person-hero .person-lifespan")).toContainText("status unknown");
    });

    test("search: result lines say status unknown, the living filter leaves unknown people out, axe clean", async ({ page }) => {
      const seen = await stub(page);
      await page.goto("/search/?q=Example&hfy_flags=searchV2", { waitUntil: "domcontentloaded" });
      const root = page.locator("#hfy-search-v2");
      await expect(meta(page, "Old Example")).toHaveText("born 1920 · status unknown");
      await expect(meta(page, "Nobirth Example")).toHaveText("birth year unknown");
      await expect(meta(page, "Active Example")).toHaveText("b. 1920 · living");
      await expect(meta(page, "Gone Example")).toHaveText("1850 – 1920");
      expect(seen.lifeState).toBe(1);
      await noSideways(page);
      expect(await axeViolations(page)).toEqual([]);
      await page.goto("/search/?q=Example&living=true&hfy_flags=searchV2", { waitUntil: "domcontentloaded" });
      await expect(root.getByRole("link", { name: /Active Example/ })).toBeVisible();
      await expect(root.getByRole("link", { name: /Old Example/ })).toHaveCount(0);
      await expect(root.getByRole("link", { name: /Nobirth Example/ })).toHaveCount(0);
    });

    test("search: flag off is today's line", async ({ page }) => {
      const seen = await stub(page, { on: false });
      await page.goto("/search/?q=Example&hfy_flags=searchV2", { waitUntil: "domcontentloaded" });
      await expect(meta(page, "Old Example")).toHaveText("b. 1920 · living");
      expect(seen.lifeState).toBe(0);
    });

    test("tree: the focus line says status unknown, an active member stays as before", async ({ page }) => {
      await stub(page);
      await page.goto(`/tree/?focus=${OLD}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("[data-tree-focus] .hfy-tree__dim").first()).toContainText("born 1920 · status unknown");
      await page.goto(`/tree/?focus=${ACTIVE}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("[data-tree-focus] .hfy-tree__dim").first()).toContainText("born 1920");
      await expect(page.locator("[data-tree-focus] .hfy-tree__dim").first()).not.toContainText("status unknown");
      await page.goto(`/tree/?focus=${NOBIRTH}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("[data-tree-focus] .hfy-tree__dim").first()).toContainText("birth year unknown");
      await noSideways(page);
      expect(await axeViolations(page)).toEqual([]);
    });

    test("tree: flag off", async ({ page }) => {
      const seen = await stub(page, { on: false });
      await page.goto(`/tree/?focus=${OLD}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("[data-tree-focus] .hfy-tree__dim").first()).toContainText("born 1920");
      await expect(page.locator("[data-tree-focus] .hfy-tree__dim").first()).not.toContainText("status unknown");
      expect(seen.lifeState).toBe(0);
    });
  });
}
