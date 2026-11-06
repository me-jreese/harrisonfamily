// HFY-TSK-388-0A pass 3: "add a photo" in the person page's photos section (island person-add-photo), flag mediaAddV1, at 375 and 1280. Synthetic people only; /auth, /api,
// the flags file and the person JSON are stubbed with the real reply shapes (api/src/uploads.js presign, api/src/web-upload.js commit). States of board B8.
// Run: HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/person-add-photo.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const BASE = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 860 }]];

async function open(page, { flag = true, session = "I9001", putStatus = 200, itemState = "applied" } = {}) {
  const state = { islandRequests: [], presign: [], puts: 0, commits: [], putStatus };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: false, profileLinks: false, mediaAddV1: flag } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: session ? { authenticated: true, sub: session, grampsId: session, label: "Sam Example" } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route("**/person/I9001.json", (r) => r.fulfill({ json: BASE }));
  await page.route("**/media/tree_I9001.svg", (r) => r.fulfill({ contentType: "image/svg+xml", body: readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8") }));
  await page.route(/\/media\/MPHOTO\d\.jpg/, (r) => r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="gray"/></svg>' }));
  await page.route(/\/js\/islands\/person-add-photo\./, (r) => { state.islandRequests.push(r.request().url()); return r.continue(); });
  await page.route("**/api/me", (r) => r.fulfill({ status: session ? 200 : 401, json: session ? { id: session, label: "Sam Example", admin: false, can: {} } : { error: "unauthenticated" } }));
  await page.route("**/api/uploads", (r) => {
    const body = r.request().postDataJSON();
    state.presign.push(body);
    const uploadId = `U${state.presign.length}`;
    return r.fulfill({ status: 201, json: { uploadUrl: new URL(`/pending/${uploadId}`, r.request().url()).href, publicUrl: `https://files.example.test/uploads/posts/${uploadId}/photo.jpg`, key: `uploads/posts/${uploadId}/photo.jpg`, headers: { "Content-Type": "image/jpeg" }, expiresIn: 900, uploadId, expiresAt: "2030-01-01T00:00:00.000Z" } });
  });
  await page.route("**/pending/*", (r) => { state.puts += 1; return r.fulfill({ status: state.putStatus, body: "" }); });
  await page.route("**/api/media/uploads", (r) => {
    const body = r.request().postDataJSON();
    state.commits.push(body);
    return r.fulfill({ json: { items: body.items.map((i) => ({ uploadId: i.uploadId, mediaId: "O9101", purpose: i.purpose, state: itemState, ...(itemState === "pending-proposal" ? { proposal: "P1" } : {}) })) } });
  });
  await page.goto("/person/?id=I9001", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-hero h1")).toHaveText("Test Person (synthetic)");
  return state;
}
async function jpeg(page, w = 240, h = 160) {
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
const openBtn = (page) => page.locator('[data-ap="open"]');
const panel = (page) => page.locator('[data-ap="panel"]');
async function toForm(page) {
  await openBtn(page).click();
  await page.locator('[data-pick="choose"]').setInputFiles(await jpeg(page));
  await expect(panel(page).getByLabel("title", { exact: true })).toBeVisible();
}

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("flag off: the bundle is not requested and no control shows", async ({ page }) => {
      const state = await open(page, { flag: false });
      await page.waitForTimeout(400);
      expect(state.islandRequests).toEqual([]);
      await expect(page.locator('[data-ap="block"]')).toHaveCount(0);
    });

    test("signed out: the bundle loads and shows nothing", async ({ page }) => {
      const state = await open(page, { session: null });
      await page.waitForTimeout(500);
      expect(state.islandRequests.length).toBeGreaterThan(0);
      await expect(page.locator('[data-ap="block"]')).toHaveCount(0);
    });

    test("own page: pick, details, upload, commit as an item, then tag people now? (states of board B8)", async ({ page }) => {
      const state = await open(page);
      await expect(openBtn(page)).toHaveText("add a photo");
      expect((await openBtn(page).boundingBox()).height).toBeGreaterThanOrEqual(44);
      expect(await axeViolations(page)).toEqual([]);
      await openBtn(page).click();
      await expect(panel(page)).toBeFocused();
      await expect(panel(page).getByRole("button", { name: "choose a photo" })).toBeVisible();
      await expect(panel(page).getByRole("button", { name: "take a photo" })).toBeVisible();
      for (const n of ["choose a photo", "take a photo"]) expect((await panel(page).getByRole("button", { name: n }).boundingBox()).height).toBeGreaterThanOrEqual(44);
      await expect(panel(page)).toContainText("we tidy each photo in your browser first");
      await expect(panel(page)).toContainText("scans of old prints are welcome.");
      await expect(page.locator(".io-media-banner")).toHaveCount(0);
      expect(await axeViolations(page)).toEqual([]);
      await page.locator('[data-pick="choose"]').setInputFiles(await jpeg(page));
      const title = panel(page).getByLabel("title", { exact: true });
      await expect(title).toBeVisible();
      expect(await title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      await panel(page).getByRole("button", { name: "add photo" }).click();
      await expect(page.getByRole("alert")).toHaveText("add a title so the family can find it.");
      expect(await axeViolations(page)).toEqual([]);
      await title.fill("Synthetic picnic");
      await panel(page).getByLabel("year (if you know it)").fill("1962");
      await panel(page).getByLabel("about", { exact: true }).check();
      await panel(page).getByLabel("what's happening").fill("A synthetic afternoon.");
      await noSideways(page);
      await panel(page).getByRole("button", { name: "add photo" }).click();
      const prompt = page.getByRole("group", { name: "tag people now?" });
      await expect(prompt).toBeVisible();
      await expect(prompt).toContainText("got it. tag people now?");
      await expect(prompt.getByRole("link", { name: "tag people" })).toHaveAttribute("href", "/person/?id=I9001#person-media-section");
      expect(state.presign).toEqual([{ purpose: "item", subject: "I9001" }]);
      expect(state.puts).toBe(1);
      expect(state.commits).toEqual([{ items: [{ uploadId: "U1", purpose: "item", subject: "I9001", title: "Synthetic picnic", year: 1962, about: true, description: "A synthetic afternoon." }] }]);
      expect(await axeViolations(page)).toEqual([]);
      await noSideways(page);
      await prompt.getByRole("button", { name: "not now" }).click();
      await expect(panel(page).getByRole("button", { name: "choose a photo" })).toBeVisible();
      await panel(page).getByRole("button", { name: "close" }).click();
      await expect(panel(page)).toHaveCount(0);
      await expect(openBtn(page)).toBeFocused();
    });

    test("a year that is not four digits is refused in words", async ({ page }) => {
      const state = await open(page);
      await toForm(page);
      await panel(page).getByLabel("title", { exact: true }).fill("Synthetic picnic");
      await panel(page).getByLabel("year (if you know it)").fill("62");
      await panel(page).getByRole("button", { name: "add photo" }).click();
      await expect(page.getByRole("alert")).toHaveText("use a four-digit year, like 1962.");
      expect(state.presign).toEqual([]);
    });

    test("another person's page: the banner says who looks first, and the commit is a proposal", async ({ page }) => {
      const state = await open(page, { session: "I9002", itemState: "pending-proposal" });
      await openBtn(page).click();
      await expect(panel(page).getByRole("note")).toHaveText("J looks first, so your photo will show as pending review until then.");
      await page.locator('[data-pick="choose"]').setInputFiles(await jpeg(page));
      await expect(panel(page).getByRole("note")).toContainText("looks first");
      await panel(page).getByLabel("title", { exact: true }).fill("Synthetic picnic");
      expect(await axeViolations(page)).toEqual([]);
      await panel(page).getByRole("button", { name: "add photo" }).click();
      await expect(page.getByRole("group", { name: "tag people now?" })).toBeVisible();
      expect(state.commits[0].items[0]).toMatchObject({ purpose: "item", subject: "I9001", title: "Synthetic picnic" });
    });

    test("a failed upload says so with the contact and the retry finishes it", async ({ page }) => {
      const state = await open(page, { putStatus: 500 });
      await toForm(page);
      await panel(page).getByLabel("title", { exact: true }).fill("Synthetic picnic");
      await panel(page).getByRole("button", { name: "add photo" }).click();
      await expect(page.getByRole("alert")).toContainText("that didn't upload. try again, or text J.");
      expect(await axeViolations(page)).toEqual([]);
      expect(state.commits).toEqual([]);
      state.putStatus = 200;
      await page.getByRole("button", { name: "try again" }).click();
      await expect(page.getByRole("group", { name: "tag people now?" })).toBeVisible();
      expect(state.commits.length).toBe(1);
    });
  });
}
