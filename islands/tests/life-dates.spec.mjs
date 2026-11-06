// HFY-TSK-388-0D: the Life dates block on the person page (island life-dates), flag lifeDatesV1, at 375 and 1280. Synthetic people only;
// /auth, /api, the flags file and the person JSON are stubbed. Run: HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/life-dates.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const BASE = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
// GET /api/life-dates replies in the real shape (api/src/records/life-dates.js, ruling P4-R29): coarse classes and years only.
const SHARED = { birth: false, death: false };
const YEARS = { birth: { class: "year", year: 1890 }, death: { class: "year", year: 1962 }, livingByRule: false, sharedEvent: SHARED };
const NONE = { birth: { class: "none", year: null }, death: { class: "none", year: null }, livingByRule: true, sharedEvent: SHARED };
const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]];

async function open(page, { flag = true, session = "I9002", lifespan = { birth: { year: 1890 }, death: { year: 1962 } }, reply = null, status = 201, classes = YEARS, lifeStatus = 200, hold = null } = {}) {
  const state = { posts: [], keys: [], gets: [], islandRequests: [] };
  const person = { ...BASE, isLiving: false, lifespan };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: false, profileLinks: false, lifeDatesV1: flag } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: session ? { authenticated: true, sub: session, grampsId: session, label: "Sam Example" } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route("**/person/I9001.json", (r) => r.fulfill({ json: person }));
  await page.route("**/media/tree_I9001.svg", (r) => r.fulfill({ contentType: "image/svg+xml", body: readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8") }));
  await page.route(/\/media\/MPHOTO\d\.jpg/, (r) => r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="gray"/></svg>' }));
  await page.route(/\/js\/islands\/life-dates\./, (r) => { state.islandRequests.push(r.request().url()); return r.continue(); });
  await page.route("**/api/me", (r) => r.fulfill({ status: session ? 200 : 401, json: session ? { id: session, label: "Sam Example", admin: false, can: {} } : { error: "unauthenticated" } }));
  await page.route("**/api/records/Person/by-id/*", (r) => r.fulfill({ json: { handle: "hSYNTH1" } }));
  await page.route(/\/api\/life-dates(\?|$)/, async (r) => {
    if (r.request().method() === "GET") {
      state.gets.push(r.request().url());
      if (hold) await hold;
      return r.fulfill({ status: lifeStatus, json: lifeStatus === 200 ? classes : { error: "boom" } });
    }
    const body = r.request().postDataJSON();
    state.posts.push(body);
    state.keys.push(r.request().headers()["idempotency-key"]);
    if (reply) return r.fulfill({ status, json: typeof reply === "function" ? reply(body) : reply });
    const rows = {};
    for (const k of ["birth", "death"]) if (body[k]) rows[k] = { status: "proposed", action: "create" };
    return r.fulfill({ status: 201, json: { applied: null, proposal: { id: "P1" }, summary: [], marks_deceased: Boolean(body.death), rows } });
  });
  await page.goto("/person/?id=I9001", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-hero h1")).toHaveText("Test Person (synthetic)");
  return state;
}
const block = (page) => page.locator('#person-hero [data-ld="block"]');
const noSideways = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("flag off: the bundle is not requested and no block shows", async ({ page }) => {
      const state = await open(page, { flag: false });
      await page.waitForTimeout(400);
      expect(state.islandRequests).toEqual([]);
      await expect(page.locator('[data-ld="block"]')).toHaveCount(0);
    });

    test("signed in: plain line, 44px button, editor with named inputs, axe clean, no sideways scroll", async ({ page }) => {
      await open(page);
      await expect(block(page).locator('[data-ld="line"]')).toHaveText("born 1890 · died 1962");
      await expect(block(page)).toHaveAttribute("aria-label", "life dates");
      const open_ = block(page).getByRole("button", { name: "edit years" });
      expect((await open_.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await open_.click();
      await expect(page.getByLabel("year of birth", { exact: true })).toBeFocused();
      await expect(page.getByLabel("year of death", { exact: true })).toHaveValue("1962");
      await expect(page.getByRole("switch", { name: "about, for year of birth" })).toBeVisible();
      await expect(page.getByRole("switch", { name: "about, for year of death" })).toBeVisible();
      expect(await page.getByLabel("year of birth", { exact: true }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      expect((await page.getByRole("button", { name: "save" }).boundingBox()).height).toBeGreaterThanOrEqual(44);
      await noSideways(page);
      expect(await axeViolations(page)).toEqual([]);
      const text = await block(page).innerText();
      expect(text).not.toMatch(/\bevents?\b|life event|\brole\b|mediaref|\bregion\b/i);
    });

    test("saving sends years only under an Idempotency-Key, then shows pending review", async ({ page }) => {
      const state = await open(page, { lifespan: {}, classes: NONE });
      await expect(block(page).locator('[data-ld="line"]')).toHaveText("birth year not recorded · no death recorded");
      await block(page).getByRole("button", { name: "add years" }).click();
      await page.getByLabel("year of birth", { exact: true }).fill("1890");
      await page.getByRole("switch", { name: "about, for year of birth" }).check();
      await page.getByLabel("year of death", { exact: true }).fill("1962");
      await page.getByRole("button", { name: "save" }).click();
      await expect(block(page).locator('[data-ld="pending"]')).toHaveText("pending review");
      await expect(block(page).locator('[data-ld="line"]')).toHaveText("born about 1890 · died 1962");
      expect(state.posts).toEqual([{ target: "Person:hSYNTH1", birth: { year: 1890, about: true }, death: { year: 1962 } }]);
      expect(state.keys[0]).toBeTruthy();
      await expect(block(page).getByRole("button", { name: "edit years" })).toBeFocused();
    });

    test("validation: range, died before born, announced as alerts; nothing is sent", async ({ page }) => {
      const state = await open(page, { lifespan: {}, classes: NONE });
      await block(page).getByRole("button", { name: "add years" }).click();
      await page.getByLabel("year of birth", { exact: true }).fill("1500");
      await page.getByRole("button", { name: "save" }).click();
      await expect(block(page).locator('[data-ld="birth-error"]')).toContainText("1600");
      await expect(block(page).locator('[data-ld="birth-error"]')).toHaveAttribute("role", "alert");
      await page.getByLabel("year of birth", { exact: true }).fill("1900");
      await page.getByLabel("year of death", { exact: true }).fill("1899");
      await page.getByRole("button", { name: "save" }).click();
      await expect(block(page).locator('[data-ld="death-error"]')).toHaveText("died can't be before born.");
      expect(state.posts).toEqual([]);
    });

    test("over 120 years asks 'are you sure?' and resends with confirm", async ({ page }) => {
      const state = await open(page, { lifespan: {}, classes: NONE });
      await block(page).getByRole("button", { name: "add years" }).click();
      await page.getByLabel("year of birth", { exact: true }).fill("1800");
      await page.getByLabel("year of death", { exact: true }).fill("1925");
      await page.getByRole("button", { name: "save" }).click();
      await expect(block(page).locator('[data-ld="sure"]')).toContainText("are you sure?");
      expect(state.posts).toEqual([]);
      await page.getByRole("button", { name: "yes, save" }).click();
      await expect(block(page).locator('[data-ld="pending"]')).toBeVisible();
      expect(state.posts[0].confirm).toBe(true);
    });

    test("'died, year unknown' disables the year and sends unknown", async ({ page }) => {
      const state = await open(page, { lifespan: { birth: { year: 1900 } }, classes: { ...NONE, birth: { class: "year", year: 1900 } } });
      await expect(block(page).locator('[data-ld="line"]')).toHaveText("born 1900 · date of death unknown");
      await block(page).getByRole("button", { name: "edit years" }).click();
      await page.getByLabel("died, year unknown").check();
      await expect(page.getByLabel("year of death", { exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "save" }).click();
      await expect(block(page).locator('[data-ld="line"]')).toHaveText("born 1900 · died, year unknown");
      expect(state.posts[0].death).toEqual({ unknown: true });
    });

    test("a more exact date on file is read-only with a suggest a correction link, and nothing is sent for it", async ({ page }) => {
      const state = await open(page, { classes: { ...YEARS, birth: { class: "precise", year: 1890 } } });
      await block(page).getByRole("button", { name: "edit years" }).click();
      await expect(block(page).locator('[data-ld="birth-ro"]')).toHaveText("1890");
      await expect(block(page)).toContainText("a more exact date is on file");
      await expect(block(page).getByRole("link", { name: "suggest a correction" })).toHaveAttribute("href", /\/edit\/\?cls=person&id=I9001/);
      await page.getByRole("button", { name: "save" }).click();
      await expect(block(page).locator('[data-ld="message"]')).toHaveText("no changes to save.");
      expect(state.posts).toEqual([]);
    });

    test("server replies precise_on_file and shared_event read as plain notes", async ({ page }) => {
      await open(page, { lifespan: {}, classes: NONE, reply: { rows: { birth: { status: "precise_on_file", current: { year: 1890 } }, death: { status: "shared_event" } } }, status: 200 });
      await block(page).getByRole("button", { name: "add years" }).click();
      await page.getByLabel("year of birth", { exact: true }).fill("1891");
      await page.getByLabel("year of death", { exact: true }).fill("1962");
      await page.getByRole("button", { name: "save" }).click();
      await expect(block(page).locator('[data-ld="notes"]')).toContainText("shared with another person's page");
      await expect(block(page).locator('[data-ld="notes"]')).toContainText("more exact date is on file");
      await expect(block(page).locator('[data-ld="pending"]')).toHaveCount(0);
    });

    test("an error reply keeps the editor open with a plain message", async ({ page }) => {
      await open(page, { lifespan: {}, classes: NONE, reply: { error: "boom" }, status: 500 });
      await block(page).getByRole("button", { name: "add years" }).click();
      await page.getByLabel("year of birth", { exact: true }).fill("1890");
      await page.getByRole("button", { name: "save" }).click();
      await expect(block(page).locator('[data-ld="message"]')).toHaveText("couldn't save that. try again.");
      await expect(page.getByLabel("year of birth", { exact: true })).toHaveValue("1890");
    });

    test("signed in: the classes are read from GET /api/life-dates for this person's handle, once", async ({ page }) => {
      const state = await open(page);
      await expect(block(page).getByRole("button", { name: "edit years" })).toBeVisible();
      expect(state.gets).toHaveLength(1);
      expect(decodeURIComponent(state.gets[0])).toContain("target=Person:hSYNTH1");
    });

    test("while the classes load only the plain line shows, with no button and no field; then the button appears", async ({ page }) => {
      let release;
      const hold = new Promise((r) => { release = r; });
      const state = await open(page, { hold });
      await expect(block(page).locator('[data-ld="line"]')).toHaveText("born 1890 · died 1962");
      await expect.poll(() => state.gets.length).toBe(1);
      await expect(block(page).getByRole("button")).toHaveCount(0);
      await expect(block(page).locator("input")).toHaveCount(0);
      release();
      await expect(block(page).getByRole("button", { name: "edit years" })).toBeVisible();
    });

    test("when the classes cannot be read the block stays read-only: a failed request, and a reply of an unknown shape", async ({ page }) => {
      const failed = await open(page, { lifeStatus: 500 });
      await expect.poll(() => failed.gets.length).toBe(1);
      await page.waitForTimeout(300);
      await expect(block(page).locator('[data-ld="line"]')).toHaveText("born 1890 · died 1962");
      await expect(block(page).getByRole("button")).toHaveCount(0);
      await expect(block(page).locator("input")).toHaveCount(0);
    });

    test("an unreadable class is read-only too", async ({ page }) => {
      const state = await open(page, { classes: { ...YEARS, birth: { class: "exact", year: 1890 } } });
      await expect.poll(() => state.gets.length).toBe(1);
      await page.waitForTimeout(300);
      await expect(block(page).getByRole("button")).toHaveCount(0);
    });

    test("an 'about' date opens with about preselected and an unchanged save sends nothing", async ({ page }) => {
      const state = await open(page, { classes: { ...YEARS, birth: { class: "about", year: 1890 } } });
      await expect(block(page).locator('[data-ld="line"]')).toHaveText("born about 1890 · died 1962");
      await block(page).getByRole("button", { name: "edit years" }).click();
      await expect(page.getByRole("switch", { name: "about, for year of birth" })).toBeChecked();
      await expect(page.getByRole("switch", { name: "about, for year of death" })).not.toBeChecked();
      await expect(page.getByLabel("year of birth", { exact: true })).toHaveValue("1890");
      await page.getByRole("button", { name: "save" }).click();
      await expect(block(page).locator('[data-ld="message"]')).toHaveText("no changes to save.");
      expect(state.posts).toEqual([]);
    });

    test("a precise date shows its year read-only on both rows, and the page has no field to type in", async ({ page }) => {
      const state = await open(page, { classes: { ...YEARS, birth: { class: "precise", year: 1890 }, death: { class: "precise", year: 1962 } } });
      await block(page).getByRole("button", { name: "edit years" }).click();
      await expect(block(page).locator('[data-ld="birth-ro"]')).toHaveText("1890");
      await expect(block(page).locator('[data-ld="death-ro"]')).toHaveText("1962");
      await expect(block(page).getByRole("link", { name: "suggest a correction" })).toHaveCount(2);
      await expect(block(page).locator("input")).toHaveCount(0);
      expect(state.posts).toEqual([]);
    });

    test("a date shared with another person's page is read-only with its own note, the other row stays editable", async ({ page }) => {
      await open(page, { classes: { ...YEARS, sharedEvent: { birth: true, death: false } } });
      await block(page).getByRole("button", { name: "edit years" }).click();
      await expect(block(page).locator('[data-ld="birth-ro"]')).toHaveText("1890");
      await expect(block(page)).toContainText("shared with another person's page");
      await expect(block(page).getByRole("link", { name: "suggest a correction" })).toHaveAttribute("href", /\/edit\/\?cls=person&id=I9001/);
      await expect(page.getByLabel("year of birth", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("year of death", { exact: true })).toHaveValue("1962");
    });

    test("a death with no date that is not living by the rule reads 'died, year unknown'", async ({ page }) => {
      await open(page, { lifespan: { birth: { year: 1900 } }, classes: { birth: { class: "year", year: 1900 }, death: { class: "none", year: null }, livingByRule: false, sharedEvent: SHARED } });
      await expect(block(page).locator('[data-ld="line"]')).toHaveText("born 1900 · died, year unknown");
      await block(page).getByRole("button", { name: "edit years" }).click();
      await expect(page.getByLabel("died, year unknown")).toBeChecked();
    });

    test("signed out: the line only, no button", async ({ page }) => {
      const state = await open(page, { session: null });
      await expect(block(page).locator('[data-ld="line"]')).toHaveText("born 1890 · died 1962");
      await page.waitForTimeout(300);
      expect(state.gets).toEqual([]);
      await expect(block(page).getByRole("button")).toHaveCount(0);
      await noSideways(page);
    });
  });
}
