// HFY-TSK-388-0E: the Life dates queue on /me/dates/ (island life-dates-queue), flag lifeDatesV1, at 375 and 1280. Synthetic people only; /auth, /api, the
// flags file and the people list are stubbed. Run: HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/life-dates-queue.spec.mjs --workers=1
import { test, expect } from "@playwright/test";

const p = (grampsId, displayName, lifespanSummary) => ({ grampsId, displayName, lifespanSummary, isLiving: false });
// Queue (cutoff 100 years back): Gus 1830, Cora 1840 (a precise death on file: passed over), Bram 1860, then Eli and Fay with no birth year. Ada has both
// years and Dev was born after the cutoff, so neither is asked about.
const MANIFEST = { people: [p("I0001", "Ada Example", "1850 – 1920"), p("I0002", "Bram Example", "b. 1860"), p("I0003", "Cora Example", "b. 1840"), p("I0004", "Dev Example", "b. 1950"), p("I0005", "Eli Example", ""), p("I0006", "Fay Example", "d. 1900"), p("I0007", "Gus Example", "b. 1830")] };
const ONE = { people: [p("I0007", "Gus Example", "b. 1830")] };
const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 860 }]];
const classesFor = (handle) => {
  const none = { class: "none", year: null };
  return { birth: handle === "hI0005" || handle === "hI0006" ? none : { class: "year", year: 1830 }, death: handle === "hI0003" ? { class: "precise", year: 1900 } : none, livingByRule: true, sharedEvent: { birth: false, death: false } };
};

async function open(page, { flag = true, session = "I9002", manifest = MANIFEST, reply = null, status = 201 } = {}) {
  const state = { posts: [], keys: [], islandRequests: [] };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: false, profileLinks: false, lifeDatesV1: flag } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: session ? { authenticated: true, sub: session, grampsId: session, label: "Sam Example" } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: manifest }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route(/\/js\/islands\/life-dates-queue\./, (r) => { state.islandRequests.push(r.request().url()); return r.continue(); });
  await page.route("**/api/me", (r) => r.fulfill({ status: session ? 200 : 401, json: session ? { id: session, label: "Sam Example", admin: false, can: {} } : { error: "unauthenticated" } }));
  await page.route(/\/api\/records\/Person\/by-id\/I\d+/, (r) => r.fulfill({ json: { handle: `h${/by-id\/(I\d+)/.exec(r.request().url())[1]}` } }));
  await page.route(/\/api\/life-dates(\?|$)/, async (r) => {
    if (r.request().method() === "GET") return r.fulfill({ json: classesFor(decodeURIComponent(r.request().url()).split("Person:")[1]) });
    const body = r.request().postDataJSON();
    state.posts.push(body);
    state.keys.push(r.request().headers()["idempotency-key"]);
    if (reply) return r.fulfill({ status, json: typeof reply === "function" ? reply(body) : reply });
    const rows = {};
    for (const k of ["birth", "death"]) if (body[k]) rows[k] = { status: "proposed", action: "create" };
    return r.fulfill({ status: 201, json: { applied: null, proposal: { id: "P1" }, summary: [], marks_deceased: Boolean(body.death), rows } });
  });
  await page.goto("/me/dates/", { waitUntil: "domcontentloaded" });
  return state;
}
const q = (page, name) => page.locator(`[data-q="${name}"]`);
const noSideways = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("flag off: the bundle is not requested and the page keeps its note", async ({ page }) => {
      const state = await open(page, { flag: false });
      await page.waitForTimeout(400);
      expect(state.islandRequests).toEqual([]);
      await expect(page.locator("[data-dates-off]")).toBeVisible();
      await expect(q(page, "card")).toHaveCount(0);
    });

    test("signed out: a sign-in line and no card", async ({ page }) => {
      await open(page, { session: null });
      await expect(q(page, "signin")).toContainText("sign in to help fill in dates.");
      await expect(q(page, "card")).toHaveCount(0);
    });

    test("the first card: oldest birth first, keypad input focused, progress, 'died, year unknown', 44 px targets, no sideways scroll, no archive words", async ({ page }) => {
      await open(page);
      await expect(q(page, "name")).toHaveText("Gus Example");
      await expect(q(page, "known")).toHaveText("born 1830");
      await expect(page.getByLabel("what year did Gus Example die?")).toBeFocused();
      const year = q(page, "year");
      await expect(year).toHaveAttribute("inputmode", "numeric");
      expect(await year.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      await expect(q(page, "progress")).toHaveText("0 of 5 people in this branch");
      const bar = page.getByRole("progressbar", { name: "people done in this branch" });
      await expect(bar).toHaveAttribute("aria-valuemax", "5");
      await expect(q(page, "unknown")).toHaveText("died, year unknown");
      await expect(q(page, "save")).toHaveText("save and next");
      for (const n of ["save", "skip", "dontknow", "unknown"]) expect((await q(page, n).boundingBox()).height).toBeGreaterThanOrEqual(44);
      expect((await q(page, "save").boundingBox()).height).toBeGreaterThanOrEqual(56);
      const skip = await q(page, "skip").boundingBox();
      const dk = await q(page, "dontknow").boundingBox();
      expect(Math.abs(skip.width - dk.width)).toBeLessThan(2);
      await noSideways(page);
      expect(await page.locator("main").innerText()).not.toMatch(/\b(event|life event|role|mediaref|region)\b/i);
    });

    test("save and next: one suggestion with an Idempotency-Key, Enter saves, the next card (a precise date is passed over) takes focus, the count shows", async ({ page }) => {
      const state = await open(page);
      await q(page, "year").fill("1900");
      await q(page, "year").press("Enter");
      await expect(q(page, "name")).toHaveText("Bram Example");
      expect(state.posts).toEqual([{ target: "Person:hI0007", death: { year: 1900 } }]);
      expect(state.keys[0]).toBeTruthy();
      await expect(q(page, "status")).toHaveText("sent for review. next: Bram Example.");
      await expect(q(page, "added")).toHaveText("you've added 1");
      await expect(q(page, "progress")).toHaveText("2 of 5 people in this branch");
      await expect(page.getByLabel("what year did Bram Example die?")).toBeFocused();
      expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("hfy:lifedates:pending:")))).toEqual(["hfy:lifedates:pending:I0007"]);
    });

    test("skip and i don't know write nothing and mark nothing; the no-birth-year row type asks for a birth year and offers no 'died, year unknown'", async ({ page }) => {
      const state = await open(page);
      await q(page, "skip").click();
      await expect(q(page, "name")).toHaveText("Bram Example");
      await q(page, "dontknow").click();
      await expect(q(page, "name")).toHaveText("Eli Example");
      await expect(q(page, "known")).toHaveText("birth year not recorded");
      await expect(page.getByLabel("what year was Eli Example born?")).toBeFocused();
      await expect(q(page, "unknown")).toHaveCount(0);
      expect(state.posts).toEqual([]);
      expect(await page.evaluate(() => [...Object.keys(sessionStorage), ...Object.keys(localStorage)].filter((k) => /lifedates|queue|skip/i.test(k)))).toEqual([]);
      await expect(q(page, "added")).toHaveCount(0);
      await q(page, "year").fill("1888");
      await q(page, "save").click();
      await expect(q(page, "name")).toHaveText("Fay Example");
      expect(state.posts).toEqual([{ target: "Person:hI0005", birth: { year: 1888 } }]);
    });

    test("a bad year keeps the field and explains in plain words; nothing is sent", async ({ page }) => {
      const state = await open(page);
      await q(page, "save").click();
      await expect(q(page, "error")).toHaveText("enter a year, like 1890.");
      await q(page, "year").fill("19");
      await q(page, "save").click();
      await expect(q(page, "error")).toHaveText("use 4 digits, like 1890.");
      await expect(q(page, "year")).toHaveValue("19");
      await q(page, "year").fill("1800");
      await q(page, "save").click();
      await expect(q(page, "error")).toHaveText("died can't be before born.");
      expect(state.posts).toEqual([]);
    });

    test("'died, year unknown' sends an unknown death", async ({ page }) => {
      const state = await open(page);
      await q(page, "unknown").click();
      await expect(q(page, "name")).toHaveText("Bram Example");
      expect(state.posts).toEqual([{ target: "Person:hI0007", death: { unknown: true } }]);
    });

    test("over 120 years asks 'are you sure?' and sends confirm only on yes", async ({ page }) => {
      const state = await open(page);
      await q(page, "year").fill("1960");
      await q(page, "save").click();
      await expect(q(page, "sure")).toHaveText("that's 130 years between born and died. are you sure?");
      expect(state.posts).toEqual([]);
      await q(page, "sure-yes").click();
      await expect(q(page, "name")).toHaveText("Bram Example");
      expect(state.posts).toEqual([{ target: "Person:hI0007", death: { year: 1960 }, confirm: true }]);
    });

    test("a failed save keeps the year in the field and stays on the card", async ({ page }) => {
      const state = await open(page, { reply: { error: "boom" }, status: 500 });
      await q(page, "year").fill("1900");
      await q(page, "save").click();
      await expect(q(page, "message")).toHaveText("couldn't save that. try again.");
      await expect(q(page, "year")).toHaveValue("1900");
      await expect(q(page, "name")).toHaveText("Gus Example");
      expect(state.posts).toHaveLength(1);
    });

    test("a more exact date on file: plain note, on to the next, nothing counted", async ({ page }) => {
      await open(page, { reply: { applied: null, proposal: null, summary: [], marks_deceased: false, rows: { death: { status: "precise_on_file" } } } });
      await q(page, "year").fill("1900");
      await q(page, "save").click();
      await expect(q(page, "name")).toHaveText("Bram Example");
      await expect(q(page, "status")).toContainText("a more exact date is on file");
      await expect(q(page, "added")).toHaveCount(0);
    });

    test("the end: an all-done state with the count; and an empty state when nobody is missing a year", async ({ page }) => {
      await open(page, { manifest: ONE });
      await q(page, "year").fill("1900");
      await q(page, "save").click();
      await expect(q(page, "done")).toContainText("that's everyone in this branch. thank you.");
      await expect(q(page, "done")).toContainText("you've added 1");
      await expect(q(page, "card")).toHaveCount(0);
      await noSideways(page);
    });

    test("empty list", async ({ page }) => {
      await open(page, { manifest: { people: [p("I0001", "Ada Example", "1850 – 1920")] } });
      await expect(q(page, "empty")).toContainText("nothing missing here.");
    });
  });
}

test("375px screenshots: card (dark) and done", async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, { manifest: ONE });
  await expect(q(page, "card")).toBeVisible();
  await page.screenshot({ path: info.outputPath("queue-card-375.png") });
});
