// HFY-TSK-388-0A pass 3: the portrait control on the person page (island person-portrait), flag portraitV1, at 375 and 1280. Synthetic people only; /auth, /api, the flags
// file and the person JSON are stubbed with the real reply shapes (api/src/uploads.js presign, api/src/web-upload.js commit and portrait). States of board B7.
// Run: HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/person-portrait.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const BASE = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 860 }]];

async function open(page, { flag = true, session = "I9001", putStatus = 200, portraitState = "applied", noPhoto = false } = {}) {
  const state = { islandRequests: [], presign: [], puts: 0, commits: [], portraits: [], putStatus };
  const person = noPhoto ? { ...BASE, primaryPhoto: null } : BASE;
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: false, profileLinks: false, portraitV1: flag } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: session ? { authenticated: true, sub: session, grampsId: session, label: "Sam Example" } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route("**/person/I9001.json", (r) => r.fulfill({ json: person }));
  await page.route("**/media/tree_I9001.svg", (r) => r.fulfill({ contentType: "image/svg+xml", body: readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8") }));
  await page.route(/\/media\/MPHOTO\d\.jpg/, (r) => r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="gray"/></svg>' }));
  await page.route(/\/js\/islands\/person-portrait\./, (r) => { state.islandRequests.push(r.request().url()); return r.continue(); });
  await page.route("**/api/me", (r) => r.fulfill({ status: session ? 200 : 401, json: session ? { id: session, label: "Sam Example", admin: false, can: {} } : { error: "unauthenticated" } }));
  // POST /api/uploads (purpose portrait): the real presign reply.
  await page.route("**/api/uploads", (r) => {
    const body = r.request().postDataJSON();
    state.presign.push(body);
    const uploadId = `U${state.presign.length}`;
    return r.fulfill({ status: 201, json: { uploadUrl: new URL(`/pending/${uploadId}`, r.request().url()).href, publicUrl: `https://files.example.test/uploads/posts/${uploadId}/photo.jpg`, key: `uploads/posts/${uploadId}/photo.jpg`, headers: { "Content-Type": "image/jpeg" }, expiresIn: 900, uploadId, expiresAt: "2030-01-01T00:00:00.000Z" } });
  });
  await page.route("**/pending/*", (r) => { state.puts += 1; return r.fulfill({ status: state.putStatus, body: "" }); });
  // POST /api/media/uploads: {items: [{uploadId, mediaId, purpose, state}]}.
  await page.route("**/api/media/uploads", (r) => {
    const body = r.request().postDataJSON();
    state.commits.push(body);
    return r.fulfill({ json: { items: body.items.map((i) => ({ uploadId: i.uploadId, mediaId: "O9100", purpose: i.purpose, state: "graduated" })) } });
  });
  // POST /api/media/portrait: {state, tags: [{personId, mediaId, rect, index, state}]}.
  await page.route("**/api/media/portrait", (r) => {
    const body = r.request().postDataJSON();
    state.portraits.push(body);
    const tagState = portraitState === "pending-proposal" ? "pending-proposal" : "applied";
    return r.fulfill({ json: { state: portraitState, tags: [{ personId: body.personId, mediaId: body.mediaId, rect: body.crop, index: 0, state: tagState }], ...(tagState === "pending-proposal" ? { proposal: { id: "P1" } } : {}) } });
  });
  await page.goto("/person/?id=I9001", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-hero h1")).toHaveText("Test Person (synthetic)");
  return state;
}
async function jpeg(page, w = 200, h = 200) {
  const b64 = await page.evaluate(async ([cw, ch]) => {
    const c = document.createElement("canvas");
    c.width = cw; c.height = ch;
    const x = c.getContext("2d");
    x.fillStyle = "#808080"; x.fillRect(0, 0, cw, ch);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }, [w, h]);
  return { name: "p.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") };
}
const noSideways = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
const openBtn = (page) => page.locator('[data-pp="open"]');
const crop = (page) => page.locator('[data-pp="crop"]');

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("flag off: the bundle is not requested and no control shows", async ({ page }) => {
      const state = await open(page, { flag: false });
      await page.waitForTimeout(400);
      expect(state.islandRequests).toEqual([]);
      await expect(page.locator('[data-pp="block"]')).toHaveCount(0);
    });

    test("signed out: the bundle loads and shows nothing", async ({ page }) => {
      const state = await open(page, { session: null });
      await page.waitForTimeout(500);
      expect(state.islandRequests.length).toBeGreaterThan(0);
      await expect(page.locator('[data-pp="block"]')).toHaveCount(0);
      await expect(page.locator("#person-hero img.person-photo")).toHaveCount(1);
    });

    test("own record: change photo, full-frame crop stores null, one set-portrait call, the old photo stays in the gallery (said in words)", async ({ page }) => {
      const state = await open(page);
      await expect(openBtn(page)).toHaveText("change photo");
      expect((await openBtn(page).boundingBox()).height).toBeGreaterThanOrEqual(44);
      await expect(page.locator(".io-media-banner")).toHaveCount(0);
      expect(await axeViolations(page)).toEqual([]);
      await page.locator('[data-pp="file"]').setInputFiles(await jpeg(page));
      await expect(crop(page)).toBeVisible();
      await expect(crop(page)).toHaveAttribute("aria-label", "crop your photo");
      await expect(crop(page).locator(".io-media-crop")).toBeFocused();
      await expect(crop(page).locator(".io-media-crop")).toHaveAttribute("aria-label", /^crop square, left \d+(\.\d+)?%, top \d+(\.\d+)?%, \d+(\.\d+)?% wide$/);
      await expect(crop(page).getByRole("button", { name: /^make (smaller|bigger)$/ })).toHaveCount(2);
      for (const b of await crop(page).getByRole("button").all()) expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(44);
      expect(await axeViolations(page)).toEqual([]);
      await noSideways(page);
      await crop(page).getByRole("button", { name: "use this crop" }).click();
      await expect(page.locator('[data-pp="done"]')).toHaveText("your new photo is on the page. the old one stays in their photos.");
      expect(state.presign).toEqual([{ purpose: "portrait", subject: "I9001" }]);
      expect(state.puts).toBe(1);
      expect(state.commits).toEqual([{ items: [{ uploadId: "U1", purpose: "portrait", subject: "I9001" }] }]);
      expect(state.portraits).toEqual([{ personId: "I9001", mediaId: "O9100", crop: null }]);
      await expect(page.locator("#person-hero img.person-photo")).toHaveAttribute("src", /^blob:/);
      await expect(page.locator("#person-hero .person-portrait[data-hfy-pending]")).toHaveCount(0);
      await expect(openBtn(page)).toBeFocused();
      expect(await axeViolations(page)).toEqual([]);
      await noSideways(page);
    });

    test("own record, no photo yet: the button says add a photo", async ({ page }) => {
      await open(page, { noPhoto: true });
      await expect(openBtn(page)).toHaveText("add a photo");
    });

    test("a smaller square is sent as four whole percents", async ({ page }) => {
      const state = await open(page);
      await page.locator('[data-pp="file"]').setInputFiles(await jpeg(page));
      await crop(page).getByRole("button", { name: "make smaller" }).click();
      await crop(page).getByRole("button", { name: "move right" }).click();
      await crop(page).getByRole("button", { name: "use this crop" }).click();
      await expect(page.locator('[data-pp="done"]')).toBeVisible();
      const c = state.portraits[0].crop;
      expect(Array.isArray(c) && c.length === 4 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 100)).toBe(true);
    });

    test("escape leaves the crop, nothing is uploaded, and focus returns to the button", async ({ page }) => {
      const state = await open(page);
      await page.locator('[data-pp="file"]').setInputFiles(await jpeg(page));
      await expect(crop(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(crop(page)).toHaveCount(0);
      await expect(openBtn(page)).toBeFocused();
      expect(state.presign).toEqual([]);
    });

    test("a file that cannot be read says so and sends nothing", async ({ page }) => {
      const state = await open(page);
      await page.locator('[data-pp="file"]').setInputFiles({ name: "x.jpg", mimeType: "image/jpeg", buffer: Buffer.from("not an image") });
      await expect(page.locator('[data-pp="error"]')).toHaveText("that photo type didn't work here. try a jpeg or a screenshot.");
      expect(state.presign).toEqual([]);
    });

    test("another person's page: suggest a photo, the notice, and the end is a proposal shown pending to the sender", async ({ page }) => {
      const state = await open(page, { session: "I9002", portraitState: "pending-proposal" });
      await expect(openBtn(page)).toHaveText("suggest a photo");
      await expect(page.getByRole("note")).toHaveText("J looks first, so your photo will show as pending review until then.");
      expect(await axeViolations(page)).toEqual([]);
      await page.locator('[data-pp="file"]').setInputFiles(await jpeg(page));
      await crop(page).getByRole("button", { name: "use this crop" }).click();
      await expect(page.locator('[data-pp="pending"]')).toHaveText("pending review");
      await expect(page.getByRole("note")).toHaveText("sent. J looks first, so it shows as pending review until then.");
      await expect(page.locator("#person-hero .person-portrait[data-hfy-pending]")).toHaveCount(1);
      expect(state.portraits).toEqual([{ personId: "I9001", mediaId: "O9100", crop: null }]);
      expect(await axeViolations(page)).toEqual([]);
      await noSideways(page);
    });

    test("a failed upload says so with the contact and retries only what failed", async ({ page }) => {
      const state = await open(page, { putStatus: 500 });
      await page.locator('[data-pp="file"]').setInputFiles(await jpeg(page));
      await crop(page).getByRole("button", { name: "use this crop" }).click();
      await expect(page.getByRole("alert")).toContainText("that didn't upload. try again, or text J.");
      expect(await axeViolations(page)).toEqual([]);
      expect(state.commits).toEqual([]);
      state.putStatus = 200;
      await page.getByRole("button", { name: "try again" }).click();
      await expect(page.locator('[data-pp="done"]')).toBeVisible();
      expect(state.portraits.length).toBe(1);
    });
  });
}
