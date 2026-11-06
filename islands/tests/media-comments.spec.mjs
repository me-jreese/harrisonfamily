// HFY-TSK-389-0A: the comment thread on the media detail page (/all-media/?id=, island media-browser, flag mediaCommentsV1) at 375 and 1280.
// Synthetic people and photos only; /auth, /api/me, /api/media/:id, /api/comments, /api/uploads and the flags file are stubbed with the real reply shapes.
// At most three screenshots. Run: HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/media-comments.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { axeViolations } from "./axe.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 900 }]];
const T0 = "2026-01-01T00:00:00.000Z";
const ULID = (n) => `01JZZZZZZZZZZZZZZZZZZZ${String(n).padStart(4, "0")}`;
const ME = { id: "I9001", label: "Sam Example" };
const ANN = { id: "I9003", label: "Ann Other" };
const SUBJECT = "media:M0002";
const card = (id) => ({ mediaId: id, thumbUrl: `/t/${id}-320.png`, width: 320, height: 240, section: "media", tagCount: 0, needsTags: true, title: "Picnic by the lake", year: 1952, grampsId: id, addedAt: 100, thumb: {} });
const detail = (id) => ({ card: card(id), imageUrl: `/t/${id}-full.png`, description: "Everyone at the lake.", origin: "import", tags: [], version: "v1", commentsSubject: `media:${id}`, handle: `h${id}`, previousId: null, nextId: null, position: 1, total: 1 });
const comment = (n, author, body, attachments, can = { edit: false, delete: false, react: true }) => ({ id: ULID(n), threadId: SUBJECT, author, body, ...(attachments ? { attachments } : {}), created_at: T0, can });

async function open(page, { mediaComments = true, commentPhotos = false, comments = [], getStatus = 200, delay = 0 } = {}) {
  const s = { gets: [], created: [], presigns: [] };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, mediaBrowserV1: true, mediaCommentsV1: mediaComments, commentPhotosV1: commentPhotos } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: ME.id, grampsId: ME.id, label: ME.label } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { id: ME.id, label: ME.label, admin: false, can: {} } }));
  await page.route(/\/t\/.*\.png/, (r) => r.fulfill({ body: PNG, contentType: "image/png" }));
  await page.route(/\/api\/media\/[^/?]+(\?.*)?$/, (r) => r.fulfill({ json: detail("M0002") }));
  await page.route("**/api/uploads", (r) => { const b = r.request().postDataJSON(); s.presigns.push(b); return r.fulfill({ status: 201, json: { uploadUrl: "https://s3.example.test/put/1", publicUrl: `https://harrisonfamily.us/uploads/comments/${ULID(700)}/photo.jpg`, headers: { "Content-Type": b.contentType } } }); });
  await page.route("https://s3.example.test/**", (r) => r.fulfill({ status: 200, body: "" }));
  await page.route("**/api/comments**", async (r) => {
    const req = r.request();
    if (req.method() === "GET") {
      s.gets.push(new URL(req.url()).searchParams.get("subject"));
      if (delay) await new Promise((x) => setTimeout(x, delay));
      if (getStatus !== 200) return r.fulfill({ status: getStatus, json: { error: getStatus === 404 ? "not_found" : "internal", message: "x" } });
      return r.fulfill({ json: { thread: { id: SUBJECT, topic: "comments", comments, reactions: {} } } });
    }
    if (req.method() === "POST") {
      const b = req.postDataJSON();
      s.created.push(b);
      return r.fulfill({ status: 201, json: comment(900 + s.created.length, ME, b.body, (b.attachments || []).map((a, i) => ({ id: ULID(500 + i), ...a })), { edit: true, delete: true, react: false }) });
    }
    return r.fulfill({ status: 204, body: "" });
  });
  await page.addInitScript((id) => { sessionStorage.setItem("HFY_GATEWAY_SESSION_V1", JSON.stringify({ token: "synthetic", grampsId: id, expiresAt: Date.now() + 3600e3, verifiedAt: Date.now() })); }, ME.id);
  await page.goto("/all-media/?id=M0002", { waitUntil: "domcontentloaded" });
  return s;
}
const slot = (page) => page.locator('[data-slot="media-comments"]');
const thread = (page) => slot(page).locator("[data-hfy-comments]");
const noSideways = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
const shot = async (page, testInfo, name) => testInfo.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("flag on: the thread renders for media:<id> with comments and a reaction, axe clean, no sideways scroll", async ({ page }, testInfo) => {
      const s = await open(page, { comments: [comment(1, ANN, "what a lovely day"), comment(2, ME, "that is the old boat", undefined, { edit: true, delete: true, react: false })] });
      await expect(slot(page).getByRole("heading", { name: "comments" })).toBeVisible();
      await expect(thread(page)).toContainText("what a lovely day");
      await expect(thread(page)).toContainText("that is the old boat");
      expect(s.gets).toContain(SUBJECT);
      await noSideways(page);
      expect(await axeViolations(page)).toEqual([]);
      if (name === "375") await shot(page, testInfo, "media-comments-375");
    });

    test("flag off: the slot stays empty and no comments request is made", async ({ page }) => {
      const s = await open(page, { mediaComments: false });
      await expect(page.locator("[data-media-people]")).toBeVisible();
      await page.waitForTimeout(400);
      await expect(slot(page)).toBeEmpty();
      expect(s.gets).toEqual([]);
    });

    test("empty thread: the composer is there and a posted comment appears with the subject sent", async ({ page }) => {
      const s = await open(page);
      const box = thread(page).getByRole("textbox", { name: "say something" });
      await expect(box).toBeVisible();
      await expect(thread(page)).toContainText("no comments yet");
      await box.fill("found it in the album");
      const post = thread(page).locator("button.io-comments-post");
      expect((await post.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await post.click();
      await expect(thread(page)).toContainText("found it in the album");
      expect(s.created[0]).toMatchObject({ subject: SUBJECT, body: "found it in the album" });
    });

    test("loading: a slow read leaves the page usable, then the comments arrive", async ({ page }) => {
      await open(page, { delay: 1200, comments: [comment(1, ANN, "worth the wait")] });
      await expect(page.locator("[data-media-people]")).toBeVisible();
      await expect(slot(page).getByRole("heading", { name: "comments" })).toBeVisible();
      await expect(thread(page)).toContainText("worth the wait");
    });

    for (const status of [404, 500]) {
      test(`error ${status}: the page stays up, the people list stays, nothing sideways`, async ({ page }, testInfo) => {
        await open(page, { getStatus: status });
        await expect(page.locator("[data-media-people]")).toBeVisible();
        await expect(slot(page).getByRole("heading", { name: "comments" })).toBeVisible();
        await page.waitForTimeout(500);
        await expect(slot(page)).not.toContainText(/undefined|\[object/);
        await noSideways(page);
        expect(await axeViolations(page)).toEqual([]);
        if (status === 404 && name === "1280") await shot(page, testInfo, "media-comments-not-found-1280");
      });
    }

    test("photos on: a comment photo renders with its alt, and the 'add a photo' picker is a 44 px target; the photo is attached through the presign path", async ({ page }, testInfo) => {
      const att = { id: ULID(50), url: "https://harrisonfamily.us/uploads/comments/01JZZZZZZZZZZZZZZZZZZZ0050/photo.jpg", mime: "image/jpeg", width: 640, height: 480, alt: "the lake" };
      const s = await open(page, { commentPhotos: true, comments: [comment(3, ANN, "the same spot today", [att])] });
      await page.route("https://harrisonfamily.us/uploads/**", (r) => r.fulfill({ body: PNG, contentType: "image/png" }));
      await expect(thread(page).locator(".io-comments-photo-link img").first()).toBeVisible();
      const add = thread(page).getByRole("button", { name: "add a photo" });
      await expect(add).toBeVisible();
      const b = await add.boundingBox();
      expect(b.width).toBeGreaterThanOrEqual(44);
      expect(b.height).toBeGreaterThanOrEqual(44);
      const jpeg = await page.evaluate(async () => { const c = document.createElement("canvas"); c.width = 64; c.height = 48; const g = c.getContext("2d"); g.fillStyle = "#336699"; g.fillRect(0, 0, 64, 48); const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9)); const u = new Uint8Array(await blob.arrayBuffer()); let t = ""; u.forEach((x) => { t += String.fromCharCode(x); }); return btoa(t); });
      await thread(page).locator('input[type="file"]').setInputFiles({ name: "IMG_0001.JPG", mimeType: "image/jpeg", buffer: Buffer.from(jpeg, "base64") });
      await expect.poll(() => s.presigns.length).toBeGreaterThan(0);
      expect(s.presigns[0]).toMatchObject({ purpose: "comment", contentType: "image/jpeg" });
      await thread(page).getByRole("textbox", { name: "say something" }).fill("another one");
      await expect(thread(page).locator("button.io-comments-post")).toBeEnabled();
      await thread(page).locator("button.io-comments-post").click();
      await expect.poll(() => s.created.length).toBe(1);
      expect(s.created[0].subject).toBe(SUBJECT);
      expect(s.created[0].attachments).toHaveLength(1);
      await noSideways(page);
      if (name === "1280") await shot(page, testInfo, "media-comments-photos-1280");
    });
  });
}
