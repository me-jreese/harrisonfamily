// HFY-TSK-408: "use a photo I'm tagged in" in the portrait control (island person-portrait, flag portraitV1), at 390 and 1280. Synthetic people and photos only; /auth, /api, the
// flags file and the person JSON are stubbed with the real reply shapes (api/src/media-browser.js list and detail, api/src/web-upload.js portrait, tagged-photo variant).
// Run: HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/person-portrait-tagged.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const BASE = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
const VIEWPORTS = [["390", { width: 390, height: 844 }], ["1280", { width: 1280, height: 860 }]];
const SVG = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="gray"/></svg>`;
const card = (id, title, year) => ({
  mediaId: id, thumbUrl: `/thumbs/${id}-320.svg`, width: 800, height: 600, section: "media", tagCount: 1, needsTags: false, title, ...(year ? { year } : {}),
  grampsId: id, addedAt: "2026-01-01T00:00:00.000Z", thumb: { s320: `/thumbs/${id}-320.svg`, s800: `/thumbs/${id}-800.svg`, w: 800, h: 600 },
});
const PAGE1 = [card("MT1", "A synthetic picnic", 1990), card("MT2", "A synthetic garden")];
const PAGE2 = [card("MT3", "A synthetic porch", 2001)];

async function open(page, { session = "I9001", portraitState = "applied", list = "pages", failSaves = 0, failListOnce = false } = {}) {
  const state = { lists: [], details: [], portraits: [], presign: [], commits: [], failSaves, failList: failListOnce };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: false, profileLinks: false, portraitV1: true } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: session, grampsId: session, label: "Sam Example" } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route("**/person/I9001.json", (r) => r.fulfill({ json: BASE }));
  await page.route("**/media/tree_I9001.svg", (r) => r.fulfill({ contentType: "image/svg+xml", body: readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8") }));
  await page.route(/\/media\/MPHOTO\d\.jpg/, (r) => r.fulfill({ contentType: "image/svg+xml", body: SVG(80, 60) }));
  await page.route(/\/thumbs\/.*-320\.svg/, (r) => r.fulfill({ contentType: "image/svg+xml", body: SVG(320, 240) }));
  await page.route(/\/thumbs\/.*-800\.svg/, (r) => r.fulfill({ contentType: "image/svg+xml", body: SVG(800, 600) }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { id: session, label: "Sam Example", admin: false, can: {} } }));
  // GET /api/media?...person=: MediaPage {cards, nextCursor, counts}
  await page.route(/\/api\/media\?/, (r) => {
    const u = new URL(r.request().url());
    state.lists.push(Object.fromEntries(u.searchParams));
    if (state.failList) { state.failList = false; return r.fulfill({ status: 503, json: { error: "unavailable" } }); }
    const more = u.searchParams.get("cursor");
    const cards = list === "empty" ? [] : more ? PAGE2 : PAGE1;
    return r.fulfill({ json: { cards, nextCursor: list === "pages" && !more ? "c1.next" : null, counts: { media: cards.length, posts: 0 } } });
  });
  // GET /api/media/:id: MediaDetail with the tags of the photo (rect = the person's face box, whole percents)
  await page.route(/\/api\/media\/MT\d(\?.*)?$/, (r) => {
    const id = new URL(r.request().url()).pathname.split("/").pop();
    state.details.push(id);
    const c = [...PAGE1, ...PAGE2].find((x) => x.mediaId === id);
    return r.fulfill({ json: { card: c, imageUrl: `/thumbs/${id}-full.svg`, origin: "gramps", version: "v1", position: 1, total: 3, tags: [
      { personId: "I9500", mediaId: id, rect: [5, 5, 15, 15], index: 0, state: "applied", person: { displayName: "Other Person" } },
      { personId: "I9001", mediaId: id, rect: [40, 30, 60, 50], index: 1, state: "applied", person: { displayName: "Test Person" } },
    ] } });
  });
  await page.route("**/api/uploads", (r) => { state.presign.push(r.request().postDataJSON()); return r.fulfill({ status: 500, json: {} }); });
  await page.route("**/api/media/uploads", (r) => { state.commits.push(r.request().postDataJSON()); return r.fulfill({ status: 500, json: {} }); });
  await page.route("**/api/media/portrait", (r) => {
    const body = r.request().postDataJSON();
    state.portraits.push(body);
    if (state.failSaves > 0) { state.failSaves -= 1; return r.fulfill({ status: 503, json: { error: { code: "unavailable", message: "unavailable" } } }); }
    const tagState = portraitState === "pending-proposal" ? "pending-proposal" : "applied";
    return r.fulfill({ json: { state: portraitState, tags: [{ personId: body.person, mediaId: body.mediaId, rect: body.rect, index: 0, state: tagState }], ...(tagState === "pending-proposal" ? { proposal: "P1" } : {}) } });
  });
  await page.goto("/person/?id=I9001", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-hero h1")).toHaveText("Test Person (synthetic)");
  return state;
}
const openBtn = (page) => page.locator('[data-pp="open"]');
const choose = (page) => page.locator('[data-pp="choose"]');
const picker = (page) => page.locator('[data-pp="picker"]');
const crop = (page) => page.locator('[data-pp="tagged-crop"]');
const noSideways = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
const big = async (loc) => { for (const b of await loc.all()) expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(44); };
// nothing covers the control: the element at its centre is the control itself (or inside it)
const reachable = async (loc) => { for (const b of await loc.all()) { await b.scrollIntoViewIfNeeded(); expect(await b.evaluate((el) => { const r = el.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return t === el || el.contains(t); })).toBe(true); } };
const pickFirst = async (page) => { await openBtn(page).click(); await page.locator('[data-pp="tagged"]').click(); await page.locator('[data-pp="cell"]').first().click(); await expect(crop(page)).toBeVisible(); };

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("the choice step shows first, with no file chooser; upload a new photo then reaches the chooser and the existing crop", async ({ page }) => {
      await open(page);
      let chooser = 0;
      page.on("filechooser", () => { chooser += 1; });
      await expect(openBtn(page)).toHaveText("change photo");
      await expect(openBtn(page)).toHaveAttribute("aria-expanded", "false");
      await openBtn(page).click();
      await expect(choose(page)).toBeVisible();
      await expect(openBtn(page)).toHaveAttribute("aria-expanded", "true");
      await expect(choose(page).getByRole("button")).toHaveText(["upload a new photo", "use a photo I'm tagged in", "cancel"]);
      await expect(choose(page).getByRole("button").first()).toBeFocused();
      await page.waitForTimeout(150);
      expect(chooser).toBe(0);
      await big(choose(page).getByRole("button"));
      await reachable(choose(page).getByRole("button"));
      expect(await axeViolations(page)).toEqual([]);
      await noSideways(page);
      const fc = page.waitForEvent("filechooser");
      await page.locator('[data-pp="upload"]').click();
      const chosen = await fc;
      expect(chosen.isMultiple()).toBe(false);
      await expect(choose(page)).toHaveCount(0);
      const b64 = await page.evaluate(async () => { const c = document.createElement("canvas"); c.width = 200; c.height = 200; c.getContext("2d").fillRect(0, 0, 200, 200); const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.9)); const bytes = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (const x of bytes) s += String.fromCharCode(x); return btoa(s); });
      await chosen.setFiles({ name: "p.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") });
      await expect(page.locator('[data-pp="crop"]')).toBeVisible();
    });

    test("cancel and Escape close the choice and return focus to the button", async ({ page }) => {
      await open(page);
      await openBtn(page).click();
      await page.locator('[data-pp="choose-cancel"]').click();
      await expect(choose(page)).toHaveCount(0);
      await expect(openBtn(page)).toBeFocused();
      await openBtn(page).click();
      await page.keyboard.press("Escape");
      await expect(choose(page)).toHaveCount(0);
      await expect(openBtn(page)).toBeFocused();
    });

    test("own page: lists the photos I'm tagged in, picks one, crops around my tag, saves with one POST and no upload", async ({ page }) => {
      const state = await open(page);
      await openBtn(page).click();
      await page.locator('[data-pp="tagged"]').click();
      await expect(picker(page)).toBeVisible();
      await expect(page.locator(".hfy-pp-title")).toHaveText("photos I'm tagged in");
      await expect(page.locator('[data-pp="cell"]')).toHaveCount(2);
      expect(state.lists[0]).toMatchObject({ person: "I9001", section: "media", filter: "all" });
      await expect(page.locator('[data-pp="cell"] img').first()).toHaveAttribute("src", /MT1-320\.svg$/);
      await expect(page.locator('[data-pp="cell"]').first()).toHaveAttribute("aria-label", "A synthetic picnic, 1990");
      await big(page.locator('[data-pp="cell"], [data-pp="more"], [data-pp="picker-back"]'));
      await reachable(page.locator('[data-pp="cell"], [data-pp="more"], [data-pp="picker-back"]'));
      expect(await axeViolations(page)).toEqual([]);
      await noSideways(page);
      await page.locator('[data-pp="more"]').click();
      await expect(page.locator('[data-pp="cell"]')).toHaveCount(3);
      expect(state.lists[1]).toMatchObject({ person: "I9001", cursor: "c1.next" });
      await expect(page.locator('[data-pp="more"]')).toHaveCount(0);
      await page.locator('[data-pp="cell"]').first().click();
      await expect(crop(page)).toBeVisible();
      expect(state.details).toEqual(["MT1"]);
      await expect(crop(page).locator("img.io-media-crop-img")).toHaveAttribute("src", /MT1-800\.svg$/);
      await expect(crop(page).locator(".io-media-crop")).toBeFocused();
      // the start square is centred on the tag box [40,30,60,50] of a 4:3 photo: 40% wide, left 30%
      await expect(crop(page).locator(".io-media-crop")).toHaveAttribute("aria-label", /^crop square, left 30%, top 1[34]%, 40% wide$/);
      await expect(crop(page).getByRole("button", { name: "save" })).toBeVisible();
      await big(crop(page).getByRole("button"));
      await reachable(crop(page).getByRole("button"));
      expect(await axeViolations(page)).toEqual([]);
      await crop(page).getByRole("button", { name: "save" }).click();
      await expect(page.locator('[data-pp="done"]')).toHaveText("your new photo is on the page. the old one stays in their photos.");
      expect(state.portraits).toHaveLength(1);
      expect(Object.keys(state.portraits[0]).sort()).toEqual(["mediaId", "person", "rect"]);
      expect(state.portraits[0]).toMatchObject({ mediaId: "MT1", person: "I9001" });
      expect(state.portraits[0].rect[0]).toBe(30);
      expect(state.portraits[0].rect[2]).toBe(70);
      expect(state.presign).toEqual([]);
      expect(state.commits).toEqual([]);
      await expect(page.locator("#person-hero img.person-photo")).toHaveAttribute("src", /MT1-800\.svg$/);
      await expect(openBtn(page)).toBeFocused();
      expect(await axeViolations(page)).toEqual([]);
    });

    test("back from the crop keeps the loaded list; back from the picker returns to the choice", async ({ page }) => {
      const state = await open(page);
      await pickFirst(page);
      await crop(page).getByRole("button", { name: "back" }).click();
      await expect(picker(page)).toBeVisible();
      await expect(page.locator('[data-pp="cell"]')).toHaveCount(2);
      expect(state.lists).toHaveLength(1); // not loaded again
      await page.locator('[data-pp="picker-back"]').click();
      await expect(choose(page)).toBeVisible();
      expect(state.portraits).toEqual([]);
    });

    test("another person's page: the words are gender-neutral and the end is a proposal", async ({ page }) => {
      const state = await open(page, { session: "I9002", portraitState: "pending-proposal" });
      await expect(openBtn(page)).toHaveText("suggest a photo");
      await openBtn(page).click();
      await expect(page.locator('[data-pp="tagged"]')).toHaveText("use a photo this person is tagged in");
      await page.locator('[data-pp="tagged"]').click();
      await expect(page.locator(".hfy-pp-title")).toHaveText("photos this person is tagged in");
      expect(state.lists[0]).toMatchObject({ person: "I9001" });
      await page.locator('[data-pp="cell"]').nth(1).click();
      await expect(crop(page)).toBeVisible();
      await crop(page).getByRole("button", { name: "save" }).click();
      await expect(page.locator('[data-pp="pending"]')).toHaveText("pending review");
      expect(state.portraits[0]).toMatchObject({ mediaId: "MT2", person: "I9001" });
      await expect(page.locator("#person-hero .person-portrait[data-hfy-pending]")).toHaveCount(1);
      expect(await axeViolations(page)).toEqual([]);
    });

    test("a failed save stays in the crop with the retry copy, and the retry saves", async ({ page }) => {
      const state = await open(page, { failSaves: 1 });
      await pickFirst(page);
      await crop(page).getByRole("button", { name: "save" }).click();
      await expect(page.locator('[data-pp="save-error"]')).toHaveText("that didn't save. try again, or text J.");
      await expect(crop(page)).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await crop(page).getByRole("button", { name: "save" }).click();
      await expect(page.locator('[data-pp="done"]')).toBeVisible();
      expect(state.portraits).toHaveLength(2);
    });

    test("no tagged photos: the empty state, with a way to the upload option and back", async ({ page }) => {
      await open(page, { list: "empty" });
      await openBtn(page).click();
      await page.locator('[data-pp="tagged"]').click();
      await expect(page.locator('[data-pp="empty"]')).toHaveText("no photos with this person tagged yet.");
      await big(page.locator('[data-pp="empty-upload"], [data-pp="picker-back"]'));
      expect(await axeViolations(page)).toEqual([]);
      await page.locator('[data-pp="picker-back"]').click();
      await expect(choose(page)).toBeVisible();
      await page.locator('[data-pp="tagged"]').click();
      const fc = page.waitForEvent("filechooser");
      await page.locator('[data-pp="empty-upload"]').click();
      await fc;
      await expect(picker(page)).toHaveCount(0);
    });

    test("a list that fails says so and offers try again", async ({ page }) => {
      await open(page, { failListOnce: true });
      await openBtn(page).click();
      await page.locator('[data-pp="tagged"]').click();
      await expect(page.locator('[data-pp="list-error"]')).toHaveText("those photos didn't load. try again.");
      expect(await axeViolations(page)).toEqual([]);
      await page.locator('[data-pp="retry"]').click();
      await expect(page.locator('[data-pp="cell"]')).toHaveCount(2);
    });
  });
}
