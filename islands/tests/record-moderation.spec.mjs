// HFY-TSK-216 (hfy-moderation-record-targets, flags moderationV1 and moderationRecordsV1): an admin's moderation controls on a person page's stories (notes) and
// photo lightbox, at 375 and 1280. Synthetic people only. /auth, /api, the flags file, the person JSON and the media are stubbed by route interception, so what the
// page sends to POST /api/moderation is what is judged: the note, mediaref and media targets, never a version, and nothing at all for a member or with a flag off.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/record-moderation.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
const URL_PATH = "/person/?id=I9001";
const ADMIN = "I9099";
const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 900 }]];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="gray"/></svg>`;
const PAGE = {
  ...PERSON,
  handle: "hP1",
  notes: [{ handle: "NOTE1", raw: "# One\n\nA synthetic story.", html: "<p>A synthetic story, first.</p>" }, { handle: "NOTE2", raw: "A second synthetic story.", html: "<p>A synthetic story, second.</p>" }],
  mediaGallery: [{ handle: "MREC1", mime: "image/jpeg", title: "A synthetic photo", grampsId: "O1" }],
};

/** `flags` overrides the flags file, `admin` is /api/me's answer, `hidden` is what the records API lists for the admin. `posts` collects the moderation calls. */
async function stub(page, { flags = {}, admin = true, hidden = [], fail } = {}) {
  const state = { posts: [], island: 0 };
  const server = new Set(hidden); // what the API says is hidden now: a hide adds to it, an unhide removes, as the real overlay does
  const keyOf = (t) => (t.kind === "mediaref" ? `mediaref:${t.person}:${t.media}` : `${t.kind}:${t.handle}`);
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, moderationV1: true, moderationRecordsV1: true, ...flags } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: ADMIN, grampsId: ADMIN, label: "Admin Example" } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { id: ADMIN, label: "Admin Example", admin, can: { moderate: admin }, editing: true } }));
  await page.route("**/api/records/Person/by-id/I9001", (r) => r.fulfill({ json: { class: "Person", handle: "hP1", gramps_id: "I9001", version: 1, obj: {}, ...(server.size ? { hidden: [...server] } : {}) } }));
  await page.route("**/api/moderation", async (route) => {
    const body = route.request().postDataJSON();
    state.posts.push(body);
    if (!fail) { if (body.action === "unhide") server.delete(keyOf(body.target)); else if (body.action !== "ask" || body.hide === true) server.add(keyOf(body.target)); }
    if (fail) return route.fulfill({ status: fail, json: { error: fail === 422 ? "unsupported_target" : "forbidden", message: "no" } });
    return route.fulfill({ json: { target: body.target, moderation: body.action === "unhide" ? null : { state: "hidden", hidden: true }, item: { class: "Note", handle: "NOTE1", version: 1 } } });
  });
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/I9001.json", (r) => r.fulfill({ json: PAGE }));
  await page.route("**/media/tree_I9001.svg", (r) => r.fulfill({ contentType: "image/svg+xml", body: readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8") }));
  await page.route(/\/media\/MREC\d\.jpg/, (r) => r.fulfill({ contentType: "image/svg+xml", body: svg }));
  await page.route(/\/js\/islands\/record-moderation\.js/, (r) => { state.island += 1; return r.continue(); });
  return state;
}

const stories = (page) => page.locator("#person-stories-section [data-hfy-record-story]");
async function open(page, opts) {
  const state = await stub(page, opts);
  await page.goto(URL_PATH, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-hero h1")).toHaveText("Test Person (synthetic)");
  return state;
}
async function openLightbox(page) {
  const fig = page.locator("#person-media-grid .gallery-item").first();
  await fig.scrollIntoViewIfNeeded();
  await fig.locator("button.media-lightbox-trigger").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#mediaLightboxImage")).toBeVisible();
}

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("an admin hides a story: the note target, no version, and a hidden badge", async ({ page }) => {
      const state = await open(page);
      await expect(stories(page)).toHaveCount(2);
      const first = stories(page).first();
      const trigger = first.getByRole("button", { name: /moderate/ });
      if (viewport.width < 688) expect((await trigger.boundingBox()).height).toBeGreaterThanOrEqual(43.9); // the touch size; the desktop button is the DS button
      await trigger.click();
      await page.getByRole("button", { name: "hide story", exact: true }).click();
      await expect(first.locator("[data-hfy-record-badge=story]")).toHaveText("hidden story");
      expect(state.posts).toEqual([{ target: { kind: "note", handle: "NOTE1" }, action: "hide" }]);
      await trigger.click();
      await expect(page.getByRole("button", { name: "hide story", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "unhide story" }).click();
      await expect(first.locator("[data-hfy-record-badge]")).toHaveCount(0);
      expect(state.posts.at(-1)).toEqual({ target: { kind: "note", handle: "NOTE1" }, action: "unhide" });
    });

    test("a story the records API lists as hidden opens with its badge, and the second story is its own note", async ({ page }) => {
      const state = await open(page, { hidden: ["note:NOTE2"] });
      await expect(stories(page).nth(1).locator("[data-hfy-record-badge=story]")).toBeVisible();
      await expect(stories(page).first().locator("[data-hfy-record-badge]")).toHaveCount(0);
      await stories(page).nth(1).getByRole("button", { name: /moderate/ }).click();
      await page.getByRole("button", { name: "ask a question…" }).click();
      await page.getByLabel("note to the author").fill("where was this?");
      await page.getByRole("button", { name: "send" }).click();
      await expect.poll(() => state.posts.length).toBe(1);
      expect(state.posts[0]).toEqual({ target: { kind: "note", handle: "NOTE2" }, action: "ask", note: "where was this?", hide: false });
    });

    test("the lightbox control hides the photo on this page (mediaref) or everywhere (media)", async ({ page }) => {
      const state = await open(page);
      await openLightbox(page);
      const control = page.locator("#mediaLightbox [data-hfy-record-photo]");
      await expect(control).toBeVisible();
      await control.getByRole("button", { name: /moderate photo/ }).click();
      await page.getByRole("button", { name: "hide on this page", exact: true }).click();
      await expect(control.locator("[data-hfy-record-badge=photo]")).toBeVisible();
      await control.getByRole("button", { name: /moderate photo/ }).click();
      await expect(page.getByRole("button", { name: "unhide on this page" })).toBeVisible();
      await page.getByRole("button", { name: "hide everywhere", exact: true }).click();
      expect(state.posts).toEqual([
        { target: { kind: "mediaref", person: "hP1", media: "MREC1" }, action: "hide" },
        { target: { kind: "media", handle: "MREC1" }, action: "hide" },
      ]);
    });

    test("a refused call shows its DS line and keeps the control", async ({ page }) => {
      await open(page, { fail: 422 });
      await stories(page).first().getByRole("button", { name: /moderate/ }).click();
      await page.getByRole("button", { name: "hide story", exact: true }).click();
      await expect(page.locator("[data-hfy-mod-error]")).toHaveText("that kind of item can't be moderated yet.");
      await expect(stories(page).first().locator("[data-hfy-record-badge]")).toHaveCount(0);
    });

    test("a member sees nothing, and with either flag off the island is not even requested", async ({ page }) => {
      const member = await open(page, { admin: false });
      await expect(page.locator("#person-stories-section .story")).toHaveCount(2);
      await page.waitForTimeout(400);
      await expect(stories(page)).toHaveCount(0);
      expect(member.posts).toEqual([]);
    });

    test("flag off: no request for the island, no control", async ({ browser }) => {
      for (const flags of [{ moderationRecordsV1: false }, { moderationV1: false }]) {
        const page = await (await browser.newContext({ viewport })).newPage();
        const state = await open(page, { flags });
        await expect(page.locator("#person-stories-section .story")).toHaveCount(2);
        await page.waitForTimeout(400);
        expect(state.island).toBe(0);
        await expect(stories(page)).toHaveCount(0);
        await page.context().close();
      }
    });

    test("axe finds nothing on the page with the open menu", async ({ page }) => {
      await open(page);
      await stories(page).first().getByRole("button", { name: /moderate/ }).click();
      await expect(page.getByRole("button", { name: "hide story", exact: true })).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
    });
  });
}
