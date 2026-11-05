// HFY-TSK-187 (R-01, R-18; BRD2 9.3, 9.4, PS-11) at 375px and 1280px: the comment photo composer and the browser JPEG normalization, with
// commentPhotosV1 on (?hfy_flags=) and off (the default). /auth/session, /api, the S3 PUT and every photo are stubbed by route interception;
// the fixtures are synthetic (an invented JPEG with an orientation-6 Exif tag and an invented GPS IFD, tests/fixtures/exif-photo.mjs).
//   HFY_SITE=<dir> PW_PORT=<port> PW_CHANNEL=chromium-headless-shell npx playwright test tests/comment-photos.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";
import { inspectJpeg, withExif } from "./fixtures/exif-photo.mjs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-synthetic.json", import.meta.url), "utf8"));
const ME = { id: "I9002", label: "Sam Example" };
const ANN = { id: "I9003", label: "Ann Other" };
const T0 = "2026-01-01T00:00:00.000Z";
const ULID = (n) => `01JZZZZZZZZZZZZZZZZZZZ${String(n).padStart(4, "0")}`;
const TRACKER = "tracker.example.test";
const ON = "/person/?id=I9001&hfy_flags=personV2,commentPhotosV1";
const OFF = "/person/?id=I9001&hfy_flags=personV2";

// ---- fixtures ---------------------------------------------------------------------------------------------------------------------
// The browser's own canvas draws the source picture, so the fixture is a genuine JPEG: stored landscape, a red block in the stored top-left.
let SOURCE; // { plain: Buffer (no Exif), exif: Buffer (orientation 6 + GPS), width, height }
const SRC_W = 3000;
const SRC_H = 2000;
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  const b64 = await page.evaluate(async ([w, h]) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = "#0000ff"; g.fillRect(0, 0, w, h);
    g.fillStyle = "#ff0000"; g.fillRect(0, 0, 600, 400);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, [SRC_W, SRC_H]);
  await page.close();
  const plain = Buffer.from(b64, "base64");
  SOURCE = { plain, exif: withExif(plain), width: SRC_W, height: SRC_H };
});

// ---- the normalization itself (AC2): bytes inspected in a browser ---------------------------------------------------------------
test("normalizePhoto turns an orientation-6 JPEG carrying GPS EXIF into an upright JPEG with no EXIF and a long edge of at most 2560 px", async ({ page }) => {
  const bundle = await build({ entryPoints: [new URL("../src/lib/photo.js", import.meta.url).pathname], bundle: true, format: "iife", globalName: "HfyPhoto", write: false, logLevel: "silent" });
  await page.goto("about:blank");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const input = inspectJpeg(SOURCE.exif);
  expect(input, "the fixture does carry Exif, an orientation tag and a GPS pointer").toMatchObject({ exif: true, orientationTag: true, gpsTag: true, width: SRC_W, height: SRC_H });
  const r = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const file = new File([bytes], "IMG_0001.JPG", { type: "image/jpeg" });
    const out = await HfyPhoto.normalizePhotoDetailed(file); // eslint-disable-line no-undef
    const buf = new Uint8Array(await out.file.arrayBuffer());
    const bmp = await createImageBitmap(out.file, { imageOrientation: "from-image" });
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0);
    const px = (x, y) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)];
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { b64: btoa(s), type: out.file.type, name: out.file.name, width: out.width, height: out.height, decoded: [bmp.width, bmp.height], topLeft: px(8, 8), topRight: px(bmp.width - 9, 8), bottomLeft: px(8, bmp.height - 9) };
  }, SOURCE.exif.toString("base64"));
  const out = inspectJpeg(Buffer.from(r.b64, "base64"));
  expect(r.type).toBe("image/jpeg");
  expect(r.name, "the picked file's name does not survive").toBe("photo.jpg");
  expect(out.jpeg).toBe(true);
  expect(out.app1, "no APP1 segment at all").toBe(0);
  expect(out.exif).toBe(false);
  expect(out.gpsTag).toBe(false);
  expect(out.orientationTag, "orientation is baked into the pixels, not left as a tag").toBe(false);
  // Stored 3000x2000 with orientation 6 is shown 2000x3000; the long edge scales to 2560, so the file is 1707x2560, upright.
  expect({ width: out.width, height: out.height }).toEqual({ width: 1707, height: 2560 });
  expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(2560);
  expect({ width: r.width, height: r.height }).toEqual({ width: 1707, height: 2560 });
  expect(r.decoded, "decoded again, the JPEG needs no rotation").toEqual([1707, 2560]);
  // Rotated 90 degrees clockwise: the stored top-left (red) is now the top-right corner.
  expect(r.topRight[0], "top-right is the red block").toBeGreaterThan(180);
  expect(r.topRight[2]).toBeLessThan(90);
  expect(r.topLeft[2], "top-left is the blue field").toBeGreaterThan(180);
  expect(r.bottomLeft[2]).toBeGreaterThan(180);
});

test("a photo the browser cannot decode raises the E10 error and nothing is uploaded", async ({ page }) => {
  const bundle = await build({ entryPoints: [new URL("../src/lib/photo.js", import.meta.url).pathname], bundle: true, format: "iife", globalName: "HfyPhoto", write: false, logLevel: "silent" });
  await page.goto("about:blank");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const r = await page.evaluate(async () => {
    try { await HfyPhoto.normalizePhoto(new File(["not a picture at all"], "Holiday.heic", { type: "image/heic" })); return "no error"; } // eslint-disable-line no-undef
    catch (e) { return { name: e.name, message: e.message }; }
  });
  expect(r).toEqual({ name: "PhotoDecodeError", message: "that photo type didn't work here. try a jpeg or a screenshot." });
});

// ---- the thread -------------------------------------------------------------------------------------------------------------------
const att = (n, extra = {}) => ({ id: ULID(n), url: `/uploads/comments/${ULID(n)}/photo.jpg`, mime: "image/jpeg", width: 1707, height: 2560, ...extra });
const comment = (n, author, body, attachments, can = { edit: false, delete: false, react: true }) => ({ id: ULID(n), threadId: "person:I9001", author, body, ...(attachments ? { attachments } : {}), created_at: T0, can });

async function stub(page, { comments = [], puts = [200], signedInAs = ME } = {}) {
  const s = { asked: [], presigns: [], puts: [], created: [], n: 0, comments: [...comments] };
  page.on("request", (q) => { if (new URL(q.url()).hostname === TRACKER) s.asked.push(q.url()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.route("**/person/I9001.json", (r) => r.fulfill({ json: PERSON }));
  await page.route("**/person/*.json", (r) => (r.request().url().includes("I9001") ? r.fallback() : r.fulfill({ json: [] })));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: signedInAs.id, grampsId: signedInAs.id, label: signedInAs.label } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { id: signedInAs.id, label: signedInAs.label, admin: false, can: { moderate: false, graduate: false, approve: false } } }));
  // Every photo (the thumbnail, the comment's grid) is the same small picture, served same-origin like the gated /uploads/*.
  await page.route("**/uploads/**", (r) => r.fulfill({ body: SOURCE.plain, contentType: "image/jpeg" }));
  await page.route("https://s3.example.test/**", (r) => {
    s.puts.push({ url: r.request().url(), type: r.request().headers()["content-type"], body: r.request().postDataBuffer() });
    const status = puts[Math.min(s.puts.length - 1, puts.length - 1)];
    return r.fulfill({ status, body: "" });
  });
  await page.route("**/api/uploads", (r) => {
    s.n += 1;
    const b = r.request().postDataJSON();
    s.presigns.push(b);
    const folder = b.purpose === "comment" ? "comments" : "posts";
    return r.fulfill({ status: 201, json: { uploadUrl: `https://s3.example.test/put/${s.n}`, publicUrl: `https://harrisonfamily.us/uploads/${folder}/${ULID(100 + s.n)}/photo.jpg`, headers: { "Content-Type": b.contentType } } });
  });
  await page.route("**/api/comments**", (r) => {
    const req = r.request();
    if (req.method() === "GET") return r.fulfill({ json: { thread: { id: "person:I9001", topic: "comments", comments: s.comments, reactions: {} } } });
    if (req.method() === "POST") {
      const b = req.postDataJSON();
      s.created.push(b);
      const c = comment(900 + s.created.length, signedInAs, b.body, (b.attachments || []).map((a, i) => ({ id: ULID(500 + i), ...a })), { edit: true, delete: true, react: false });
      return r.fulfill({ status: 201, json: c });
    }
    return r.fulfill({ status: 204, body: "" });
  });
  await page.addInitScript((id) => {
    sessionStorage.setItem("HFY_GATEWAY_SESSION_V1", JSON.stringify({ token: "synthetic", grampsId: id, expiresAt: Date.now() + 3600e3, verifiedAt: Date.now() }));
  }, signedInAs.id);
  return s;
}

const thread = (page) => page.locator("[data-hfy-comments]");
const picker = (page) => thread(page).locator('input[type="file"]');
const postButton = (page) => thread(page).locator("button.io-comments-post");
const jpegFile = (name = "IMG_0001.JPG", buffer = SOURCE.exif) => ({ name, mimeType: "image/jpeg", buffer });

async function open(page, url = ON) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(thread(page).getByRole("textbox", { name: "say something" })).toBeVisible();
}

test("flag on: a 44 px 'add a photo' button, a thumbnail with 'add a caption' and remove, and a photo-only comment is posted with the normalized photo", async ({ page }) => {
  const s = await stub(page);
  await open(page);
  const add = thread(page).getByRole("button", { name: "add a photo" });
  await expect(add).toBeVisible();
  const box = await add.boundingBox();
  expect(box.width, "add a photo is at least 44 px wide").toBeGreaterThanOrEqual(44);
  expect(box.height, "add a photo is at least 44 px tall").toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll at 375").toBe(true);
  await expect(postButton(page), "nothing to post yet").toBeDisabled();
  await expect(picker(page)).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");

  await picker(page).setInputFiles(jpegFile());
  const row = thread(page).locator(".io-comments-picked-item");
  await expect(row).toHaveCount(1);
  await expect(row.locator("img.io-comments-thumb")).toBeVisible();
  const thumb = await row.locator("img.io-comments-thumb").boundingBox();
  expect(thumb.width).toBeGreaterThanOrEqual(44);
  const caption = row.getByRole("textbox", { name: "add a caption" });
  await expect(caption).toBeVisible();
  await expect(caption).toHaveAttribute("placeholder", "add a caption");
  const remove = row.getByRole("button", { name: /^remove/ });
  expect((await remove.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await expect(postButton(page), "a photo alone is enough to post").toBeEnabled();
  expect(await thread(page).getByRole("textbox", { name: "say something" }).inputValue()).toBe("");

  // What was uploaded: presigned for a comment, the PUT body is the normalized JPEG, not the Exif original.
  expect(s.presigns).toHaveLength(1);
  expect(s.presigns[0]).toMatchObject({ purpose: "comment", contentType: "image/jpeg", filename: "photo" });
  expect(JSON.stringify(s.presigns)).not.toMatch(/IMG_0001/);
  expect(s.puts).toHaveLength(1);
  expect(s.puts[0].type).toBe("image/jpeg");
  const sent = inspectJpeg(s.puts[0].body);
  expect(sent).toMatchObject({ jpeg: true, app1: 0, exif: false, gpsTag: false, width: 1707, height: 2560 });
  expect(s.puts[0].body.equals(SOURCE.exif), "not the original bytes").toBe(false);

  await caption.fill("the dock at dusk");
  expect(await axeViolations(page, { include: "[data-hfy-comments]" })).toEqual([]);
  await postButton(page).click();
  await expect.poll(() => s.created.length).toBe(1);
  expect(s.created[0]).toEqual({
    subject: "person:I9001", body: "",
    attachments: [{ url: `/uploads/comments/${ULID(101)}/photo.jpg`, mime: "image/jpeg", width: 1707, height: 2560, alt: "the dock at dusk" }],
  });
  // The posted comment draws the photo with the who-photo alt and the caption as a visible figcaption (P2-R47).
  const mine = thread(page).locator(".io-comments-list > li", { has: page.locator("figure") });
  await expect(mine).toHaveCount(1);
  await expect(mine.locator("figcaption")).toHaveText("the dock at dusk");
  await expect(mine.locator("figure img")).toHaveAttribute("alt", "a photo from Sam Example");
  await expect(thread(page).locator(".io-comments-picked-item"), "the composer is cleared").toHaveCount(0);
});

test("up to 4 photos: the fifth is not accepted and the button is disabled at 4", async ({ page }) => {
  const s = await stub(page);
  await open(page);
  for (let i = 1; i <= 4; i += 1) {
    await picker(page).setInputFiles(jpegFile(`IMG_000${i}.JPG`));
    await expect(thread(page).locator('.io-comments-picked-item[data-status="done"]')).toHaveCount(i);
  }
  await expect(thread(page).getByRole("button", { name: "add a photo" })).toBeDisabled();
  expect(s.puts).toHaveLength(4);
  await thread(page).locator(".io-comments-picked-item").first().getByRole("button", { name: /^remove/ }).click();
  await expect(thread(page).getByRole("button", { name: "add a photo" })).toBeEnabled();
});

test("an S3 403 re-presigns once and the PUT is retried; the photo is still added", async ({ page }) => {
  const s = await stub(page, { puts: [403, 200] });
  await open(page);
  await picker(page).setInputFiles(jpegFile());
  await expect(thread(page).locator('.io-comments-picked-item[data-status="done"]')).toHaveCount(1);
  expect(s.presigns).toHaveLength(2);
  expect(s.puts.map((p) => p.url)).toEqual(["https://s3.example.test/put/1", "https://s3.example.test/put/2"]);
  await postButton(page).click();
  await expect.poll(() => s.created.length).toBe(1);
  expect(s.created[0].attachments[0].url).toBe(`/uploads/comments/${ULID(102)}/photo.jpg`);
});

test("two S3 403s in a row show 'that didn't upload. try again.' and take no slot", async ({ page }) => {
  const s = await stub(page, { puts: [403] });
  await open(page);
  await picker(page).setInputFiles(jpegFile());
  await expect(thread(page).getByRole("alert").filter({ hasText: "that didn't upload. try again." })).toBeVisible();
  expect(s.presigns, "one automatic re-presign, never more").toHaveLength(2);
  await expect(postButton(page)).toBeDisabled();
});

test("a photo the browser cannot decode shows the E10 copy and nothing is presigned or sent", async ({ page }) => {
  const s = await stub(page);
  await open(page);
  await picker(page).setInputFiles({ name: "Holiday.jpg", mimeType: "image/jpeg", buffer: Buffer.from("this is not a picture") });
  await expect(thread(page).getByRole("alert").filter({ hasText: "that photo type didn't work here. try a jpeg or a screenshot." })).toBeVisible();
  expect([s.presigns.length, s.puts.length]).toEqual([0, 0]);
  await expect(postButton(page)).toBeDisabled();
});

test("the caption is guarded like the text (R-18): a phone number marks the caption and disables post until it is removed", async ({ page }) => {
  await stub(page);
  await open(page);
  await picker(page).setInputFiles(jpegFile());
  const caption = thread(page).getByRole("textbox", { name: "add a caption" });
  await expect(postButton(page)).toBeEnabled();
  await caption.fill("text me on 555-0142");
  await expect(thread(page).locator("[data-hfy-guard-msg]")).toContainText("phone number");
  await expect(postButton(page)).toBeDisabled();
  await caption.fill("the dock at dusk");
  await expect(thread(page).locator("[data-hfy-guard-msg]")).toHaveCount(0);
  await expect(postButton(page), "a photo alone enables post again once the hit is gone").toBeEnabled();
});

// The comment's photo grid, the attachment-reaction rule and the sanitize policy (AC5, AC6), in one thread.
const GRID = comment(1, ANN, "hello\n\n![tracker](https://tracker.example.test/pixel.png)\n\n[write me](mailto:someone@example.test) or [read more](https://example.test/read)", [
  att(11, { alt: "the lake in june" }), att(12), att(13, { alt: "  " }), att(14, { alt: "the cabin" }),
]);

for (const flagsOn of [true, false]) {
  test(`flag ${flagsOn ? "on" : "off"}: a markdown image to an external host in a comment is never requested and mailto: is no link`, async ({ page }) => {
    const s = await stub(page, { comments: [GRID] });
    await open(page, flagsOn ? ON : OFF);
    const li = thread(page).locator(".io-comments-list > li").first();
    await expect(li.locator(".io-comments-body")).toContainText("hello");
    await expect(li.locator(".io-comments-media img").first()).toBeVisible();
    await page.waitForTimeout(600); // an image request would have started by now
    expect(s.asked, `a request went to ${TRACKER}`).toEqual([]);
    const r = await li.evaluate((el) => ({
      bodyImages: el.querySelectorAll(".io-comments-body img").length,
      mailto: el.querySelectorAll('a[href^="mailto:"]').length,
      writeMeIsLink: [...el.querySelectorAll("a")].some((a) => a.textContent === "write me"),
      readMore: [...el.querySelectorAll(".io-comments-body a")].map((a) => ({ href: a.getAttribute("href"), rel: a.rel })),
      attachmentImages: el.querySelectorAll(".io-comments-media img").length,
    }));
    expect(r.bodyImages, "no <img> inside the markdown body").toBe(0);
    expect(r.mailto).toBe(0);
    expect(r.writeMeIsLink).toBe(false);
    expect(r.readMore).toEqual([{ href: "https://example.test/read", rel: "noopener noreferrer nofollow ugc" }]);
    expect(r.attachmentImages, "the attachments are the only images").toBe(4);
  });
}

test("comment photos: a grid of 2 columns at 375 and 4 on desktop, captions visible, who-photo alts, no reactions on photos; axe clean", async ({ page }) => {
  await stub(page, { comments: [GRID] });
  await open(page);
  const media = thread(page).locator(".io-comments-media");
  await expect(media.locator("img").first()).toBeVisible();
  const cols = () => media.evaluate((ul) => getComputedStyle(ul).gridTemplateColumns.split(" ").length);
  expect(await cols()).toBe(2);
  const rows = await media.locator("li").evaluateAll((lis) => new Set(lis.map((l) => Math.round(l.getBoundingClientRect().top))).size);
  expect(rows, "four photos in two columns are two rows").toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(media.locator("figcaption")).toHaveText(["the lake in june", "the cabin"]);
  expect(await media.locator("img").evaluateAll((imgs) => imgs.map((i) => i.alt))).toEqual(["photo 1 of 4 from Ann Other", "photo 2 of 4 from Ann Other", "photo 3 of 4 from Ann Other", "photo 4 of 4 from Ann Other"]);
  expect(await media.locator("a").evaluateAll((as) => as.map((a) => [a.target, a.rel]))).toEqual(Array(4).fill(["_blank", "noopener"]));
  await expect(media.locator("button, [aria-pressed]"), "attachment reactions are off").toHaveCount(0);
  // The comment's own reactions are still there.
  await expect(thread(page).locator(".io-comments-list > li").first().locator(".io-comments-reactions")).toHaveCount(1);
  expect(await axeViolations(page, { include: "[data-hfy-comments]" })).toEqual([]);

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(cols).toBe(4);
  const row1 = await media.locator("li").evaluateAll((lis) => new Set(lis.map((l) => Math.round(l.getBoundingClientRect().top))).size);
  expect(row1, "four photos in four columns are one row").toBe(1);
  expect(await axeViolations(page, { include: "[data-hfy-comments]" })).toEqual([]);
});

test("flag off: no photo picker, and a photo already on a comment still draws", async ({ page }) => {
  await stub(page, { comments: [GRID] });
  await open(page, OFF);
  await expect(thread(page).getByRole("button", { name: "add a photo" })).toHaveCount(0);
  await expect(picker(page)).toHaveCount(0);
  await expect(thread(page).locator(".io-comments-media img")).toHaveCount(4);
});

// ---- post photos use the same normalization (AC4) -------------------------------------------------------------------------------------
async function stubPosts(page) {
  const s = await stub(page, { signedInAs: { id: "I9001", label: "Test Person" } });
  await page.route(/\/api\/posts(\/[^/?]+)?(\?.*)?$/, (r) => {
    const req = r.request();
    if (req.method() === "GET") return r.fulfill({ json: { items: [], cursor: null } });
    const b = req.postDataJSON();
    return r.fulfill({ status: 201, json: { id: ULID(700), type: "post", author: { id: "I9001", label: "Test Person" }, subject: b.subject, body: b.body, attachments: b.attachments || [], visibility: "draft", created_at: T0, updated_at: T0, can: { edit: true, delete: true, publish: true } } });
  });
  return s;
}

test("commentPhotosV1 on: a post photo is normalized too (no Exif, no GPS, upright), and the picker drops heic", async ({ page }) => {
  const s = await stubPosts(page);
  await page.goto("/person/?id=I9001&hfy_flags=postsV2,commentPhotosV1", { waitUntil: "domcontentloaded" });
  const mine = page.locator("[data-hfy-my-posts]");
  await expect(mine.getByRole("heading", { name: "share something" })).toBeVisible();
  const input = mine.locator("input[type=file]").first();
  await expect.poll(() => input.getAttribute("accept")).toBe("image/jpeg,image/png,image/webp");
  await input.setInputFiles(jpegFile());
  await expect.poll(() => s.puts.length).toBe(1);
  expect(s.presigns[0]).toMatchObject({ contentType: "image/jpeg", filename: "photo" });
  expect(s.presigns[0].purpose, "a post presign has no purpose: the API default is post").toBeUndefined();
  expect(inspectJpeg(s.puts[0].body)).toMatchObject({ jpeg: true, app1: 0, exif: false, gpsTag: false, width: 1707, height: 2560 });
});

test("commentPhotosV1 off: a post photo goes up exactly as picked", async ({ page }) => {
  const s = await stubPosts(page);
  await page.goto("/person/?id=I9001&hfy_flags=postsV2", { waitUntil: "domcontentloaded" });
  const mine = page.locator("[data-hfy-my-posts]");
  await expect(mine.getByRole("heading", { name: "share something" })).toBeVisible();
  const input = mine.locator("input[type=file]").first();
  await expect(input).toHaveAttribute("accept", /image\/heic/);
  await input.setInputFiles(jpegFile());
  await expect.poll(() => s.puts.length).toBe(1);
  expect(s.puts[0].body.equals(SOURCE.exif), "the original bytes").toBe(true);
});

test("a post photo the browser cannot decode shows the E10 copy (flag on)", async ({ page }) => {
  const s = await stubPosts(page);
  await page.goto("/person/?id=I9001&hfy_flags=postsV2,commentPhotosV1", { waitUntil: "domcontentloaded" });
  const mine = page.locator("[data-hfy-my-posts]");
  await expect(mine.getByRole("heading", { name: "share something" })).toBeVisible();
  await mine.locator("input[type=file]").first().setInputFiles({ name: "Holiday.jpg", mimeType: "image/jpeg", buffer: Buffer.from("this is not a picture") });
  await expect(mine.getByText("that photo type didn't work here. try a jpeg or a screenshot.").first()).toBeVisible();
  expect(s.puts).toHaveLength(0);
});
