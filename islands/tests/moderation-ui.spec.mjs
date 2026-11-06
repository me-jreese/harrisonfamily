// HFY-TSK-191 (R-32; social.md 11.6) at 375 px and 1280 px: the admin moderation controls on posts, stories, comments and photos, the ask form, the
// hidden badge with "unhide", and the author's banner, with moderationV1 on (?hfy_flags=) and off (the default). Three mocked viewers (an admin,
// the author and another member) see what the server would send them; /auth/session, /api/me, /api/posts, /api/comments and /api/moderation are
// stubbed by route interception. Synthetic data only.
//   HFY_SITE=<dir> PW_PORT=<port> PW_CHANNEL=chromium-headless-shell npx playwright test tests/moderation-ui.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ULID = (n) => `01JZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(3, "0")}`;
const T0 = "2026-01-01T00:00:00.000Z";
const ADMIN = { id: "I9002", label: "Ada Example" };
const AUTHOR = { id: "I9003", label: "Ann Other" };
const MEMBER = { id: "I9004", label: "Mo Member" };
// moderationV1 comes from the flags file, as in production (a ?hfy_flags= override would add a fixed "preview flags" banner over the bottom edge).
const FLAGS = JSON.parse(readFileSync(new URL("../../11ty/_data/flags.json", import.meta.url), "utf8"));

const PHOTO_A = { kind: "image", url: `/uploads/posts/${ULID(71)}/a.jpg`, mime: "image/jpeg", alt: "first photo" };
const PHOTO_B = { kind: "image", url: `/uploads/posts/${ULID(72)}/b.jpg`, mime: "image/jpeg", alt: "second photo" };

const post = (n, over = {}) => ({ id: ULID(n), type: "post", author: AUTHOR, body: `Synthetic post ${n}`, attachments: [], visibility: "published", created_at: T0, updated_at: T0, can: { edit: false, delete: false, publish: false, moderate: false }, ...over });
const asAdmin = (p) => ({ ...p, can: { ...p.can, moderate: true } });
const asAuthor = (p) => ({ ...p, can: { ...p.can, edit: true, delete: true, moderate: false } });
const HIDE = { state: "hidden", hidden: true, by: ADMIN, at: T0, open: true };
const ASK = { state: "changes_requested", hidden: true, by: ADMIN, at: T0, note: "Please add who is in the photo.", open: true };
const QUESTION = { state: "question", hidden: false, by: ADMIN, at: T0, note: "Which summer was this?", open: true };

/**
 * `viewer`: admin | author | member. `posts` is what the server would send THAT viewer. The moderation route answers with the post as the admin
 * would see it after the action (`after(body)`), and records every body.
 */
async function stub(page, { viewer = "admin", posts = [], comments = [], after, me, flag = true } = {}) {
  const s = { moderation: [], patches: [], me: 0, comments: [...comments], posts: [...posts] };
  const who = { admin: ADMIN, author: AUTHOR, member: MEMBER }[viewer];
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { ...FLAGS, postsV2: true, moderationV1: flag } }));
  await page.route("**/uploads/**", (r) => r.fulfill({ body: PNG, contentType: "image/png" }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: who.id, grampsId: who.id, label: who.label } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/api/me", (r) => {
    s.me += 1;
    return r.fulfill({ json: me ?? { id: who.id, label: who.label, admin: viewer === "admin", can: { moderate: viewer === "admin", graduate: viewer === "admin", approve: viewer === "admin" } } });
  });
  await page.route(/\/api\/posts(\/[^/?]+)?(\?.*)?$/, (r) => {
    const req = r.request();
    const id = new URL(req.url()).pathname.split("/")[3];
    if (req.method() === "PATCH") {
      s.patches.push(req.postDataJSON());
      const cur = s.posts.find((p) => p.id === id);
      const next = { ...cur, ...req.postDataJSON(), moderation: undefined, updated_at: "2026-01-02T00:00:00.000Z" };
      delete next.moderation;
      s.posts = s.posts.map((p) => (p.id === id ? next : p));
      return r.fulfill({ json: next });
    }
    if (id) { const p = s.posts.find((x) => x.id === id); return p ? r.fulfill({ json: p }) : r.fulfill({ status: 404, json: { error: "not_found" } }); }
    return r.fulfill({ json: { items: s.posts, cursor: null } });
  });
  await page.route("**/api/comments**", (r) => {
    const req = r.request();
    if (req.method() === "GET") return r.fulfill({ json: { thread: { id: "t", topic: "comments", comments: s.comments, reactions: {} } } });
    return r.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/moderation", (r) => {
    const body = r.request().postDataJSON();
    s.moderation.push(body);
    if (s.refuse) return r.fulfill({ status: s.refuse.status, json: { error: s.refuse.error, message: "refused" } });
    const item = after ? after(body, s) : undefined;
    return r.fulfill({ json: { target: body.target, moderation: item?.moderation ?? null, item } });
  });
  await page.addInitScript(() => sessionStorage.setItem("HFY_GATEWAY_SESSION_V1", JSON.stringify({ token: "synthetic", grampsId: "I9002", expiresAt: Date.now() + 3600e3, verifiedAt: Date.now() })));
  return s;
}

const feed = (page) => page.locator("[data-hfy-posts]");
const row = (page, n) => feed(page).locator("li.hfy-posts__post", { hasText: `Synthetic post ${n}` });
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const box = async (loc) => (await loc.boundingBox());

// ------------------------------------------------------------------------------------------------------------------- three viewers
test("three viewers: the admin sees the control, the badge and unhide; the author the banner and edit; another member sees neither the item nor a control", async ({ browser }) => {
  const hidden = post(1, { moderation: ASK });
  const plain = post(2);
  const quiet = post(3);
  const views = {
    admin: [asAdmin(hidden), asAdmin(plain), asAdmin(quiet)],
    author: [asAuthor(hidden), asAuthor(plain), asAuthor(quiet)],
    // the server withholds the hidden post from everyone else
    member: [plain, quiet],
  };
  const seen = {};
  for (const viewer of ["admin", "author", "member"]) {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    await stub(page, { viewer, posts: views[viewer] });
    await page.goto("/posts/", { waitUntil: "domcontentloaded" });
    await expect(row(page, 2)).toBeVisible();
    // settle: the flag and the viewer have resolved once the controls (or their absence) are decided
    await page.waitForTimeout(400);
    seen[viewer] = {
      hiddenRow: await row(page, 1).count(),
      controls: await feed(page).locator("[data-hfy-moderate]").count(),
      badge: await feed(page).locator("[data-hfy-mod-badge]").count(),
      unhide: await feed(page).getByRole("button", { name: "unhide", exact: true }).count(),
      banner: await feed(page).locator("[data-hfy-mod-banner]").count(),
      edit: await feed(page).getByRole("button", { name: "edit", exact: true }).count(),
    };
    if (viewer === "admin") {
      await expect(row(page, 1).locator("[data-hfy-mod-badge]")).toHaveText("hidden");
      await expect(row(page, 1)).toContainText("Ada Example asked: Please add who is in the photo.");
      await expect(row(page, 1).getByRole("link", { name: "Ada Example" })).toHaveAttribute("href", "/person/?id=I9002");
    }
    if (viewer === "author") {
      const banner = row(page, 1).getByRole("status").filter({ hasText: "asked:" });
      await expect(banner).toHaveText("Ada Example asked: Please add who is in the photo. — edit it to show it again.");
      await expect(row(page, 1).locator('[role="alert"]')).toHaveCount(0); // neutral, not a danger alert
      await expect(row(page, 1).getByRole("button", { name: "edit", exact: true })).toBeVisible();
    }
    await ctx.close();
  }
  expect(seen.admin).toEqual({ hiddenRow: 1, controls: 3, badge: 1, unhide: 1, banner: 0, edit: 0 });
  expect(seen.author).toEqual({ hiddenRow: 1, controls: 0, badge: 0, unhide: 0, banner: 1, edit: 1 });
  expect(seen.member).toEqual({ hiddenRow: 0, controls: 0, badge: 0, unhide: 0, banner: 0, edit: 0 });
});

test("another member never draws a hidden post, even one the server wrongly sent", async ({ page }) => {
  await stub(page, { viewer: "member", posts: [post(1, { moderation: HIDE }), post(2)] });
  await page.goto("/posts/", { waitUntil: "domcontentloaded" });
  await expect(row(page, 2)).toBeVisible();
  await page.waitForTimeout(300);
  await expect(row(page, 1)).toHaveCount(0);
  await expect(page.getByText("a moderator hid this.")).toHaveCount(0);
});

test("a plain hide tells the author a moderator hid it, and a visible question carries no edit-to-show line", async ({ page }) => {
  await stub(page, { viewer: "author", posts: [asAuthor(post(1, { moderation: HIDE })), asAuthor(post(2, { moderation: QUESTION }))] });
  await page.goto("/posts/", { waitUntil: "domcontentloaded" });
  await expect(row(page, 1).locator("[data-hfy-mod-banner]")).toHaveText("a moderator hid this.");
  await expect(row(page, 2).locator("[data-hfy-mod-banner]")).toHaveText("Ada Example asked: Which summer was this?");
});

test("flag off (the default): no control, no badge, no banner, and no /api/me request", async ({ page }) => {
  const s = await stub(page, { viewer: "admin", posts: [asAdmin(post(1, { moderation: HIDE })), asAdmin(post(2))], flag: false });
  await page.goto("/posts/", { waitUntil: "domcontentloaded" });
  await expect(row(page, 2)).toBeVisible();
  await page.waitForTimeout(400);
  await expect(feed(page).locator("[data-hfy-moderate], [data-hfy-mod-badge], [data-hfy-mod-banner]")).toHaveCount(0);
  expect(s.me).toBe(0);
  expect(s.moderation).toEqual([]);
});

// ------------------------------------------------------------------------------------------------------------------- the menu and the Sheet
test("at 1280 px the control opens a small menu under the button; Escape closes it and gives focus back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await stub(page, { viewer: "admin", posts: [asAdmin(post(1))] });
  await page.goto("/posts/", { waitUntil: "domcontentloaded" });
  const trigger = row(page, 1).getByRole("button", { name: /^moderate/ });
  await expect(trigger).toBeVisible();
  expect((await box(trigger)).height).toBeGreaterThanOrEqual(43.5);
  await trigger.click();
  const menu = page.getByRole("dialog", { name: "moderate" });
  await expect(menu).toHaveAttribute("data-variant", "menu");
  await expect(menu.getByRole("button")).toHaveText(["hide", "ask for changes…", "ask a question…"]);
  const [t, m] = [await box(trigger), await box(menu)];
  expect(m.y).toBeGreaterThanOrEqual(t.y + t.height - 1); // under the button
  expect(m.height).toBeLessThan(400);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // a press outside closes it too
  await trigger.click();
  await expect(menu).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(menu).toHaveCount(0);
});

test("at 375 px the control opens a bottom Sheet with 56 px rows; the page behind is inert and Escape closes it", async ({ page }) => {
  await stub(page, { viewer: "admin", posts: [asAdmin(post(1))] });
  await page.goto("/posts/", { waitUntil: "domcontentloaded" });
  const trigger = row(page, 1).getByRole("button", { name: /^moderate/ });
  await trigger.click();
  const sheet = page.getByRole("dialog", { name: "moderate" });
  await expect(sheet).toHaveAttribute("data-variant", "sheet");
  await expect(sheet).toHaveJSProperty("open", true);
  const b = await box(sheet);
  expect(Math.round(b.x)).toBe(0);
  expect(Math.round(b.width)).toBe(375);
  expect(Math.round(b.y + b.height)).toBe(812); // docked to the bottom edge
  const rows = sheet.locator(".hfy-mod__row");
  await expect(rows).toHaveCount(3);
  for (const r of await rows.all()) expect(Math.round((await box(r)).height)).toBe(56);
  expect(await noHScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

// ------------------------------------------------------------------------------------------------------------------- hide, ask, unhide
test("hide sends one POST /api/moderation for the post with the version the admin saw, pings, and shows the badge with unhide", async ({ page }) => {
  const s = await stub(page, {
    viewer: "admin", posts: [asAdmin(post(1))],
    after: (b) => asAdmin(post(1, { moderation: b.action === "hide" ? HIDE : undefined })),
  });
  await page.goto("/posts/", { waitUntil: "domcontentloaded" });
  await row(page, 1).getByRole("button", { name: /^moderate/ }).click();
  await page.getByRole("button", { name: "hide", exact: true }).click();
  await expect(row(page, 1).getByRole("status").filter({ hasText: "hidden. they'll get a note." })).toBeVisible();
  expect(s.moderation).toEqual([{ target: { kind: "post", id: ULID(1) }, action: "hide", version: T0 }]);
  await expect(row(page, 1).locator("[data-hfy-mod-badge]")).toHaveText("hidden");
  // unhide: one tap, no menu
  s.moderation.length = 0;
  await row(page, 1).getByRole("button", { name: "unhide", exact: true }).click();
  await expect(row(page, 1).getByRole("status").filter({ hasText: "unhidden." })).toBeVisible();
  expect(s.moderation).toEqual([{ target: { kind: "post", id: ULID(1) }, action: "unhide", version: T0 }]);
  await expect(row(page, 1).locator("[data-hfy-mod-badge]")).toHaveCount(0);
});

for (const [name, action, label, checked, disabled, hide] of [
  ["ask for changes: the keep-hidden box starts checked (and the server always hides)", "request_changes", "ask for changes…", true, true, undefined],
  ["ask a question: the keep-hidden box starts unchecked", "ask", "ask a question…", false, false, false],
]) {
  test(`the ask form, ${name}; the note is required, counted to 1000, and sent with the item`, async ({ page }) => {
    const s = await stub(page, { viewer: "admin", posts: [asAdmin(post(1))], after: (b) => asAdmin(post(1, { moderation: { ...ASK, state: b.action === "ask" ? "question" : "changes_requested", hidden: b.action === "request_changes" || b.hide === true, note: b.note } })) });
    await page.goto("/posts/", { waitUntil: "domcontentloaded" });
    await row(page, 1).getByRole("button", { name: /^moderate/ }).click();
    await page.getByRole("button", { name: label, exact: true }).click();
    const form = page.locator(`[data-hfy-ask="${action}"]`);
    const send = form.getByRole("button", { name: "send", exact: true });
    const note = form.getByRole("textbox", { name: "note to the author" });
    await expect(note).toBeFocused();
    expect(await note.evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16);
    const keep = form.getByRole("checkbox", { name: "keep it hidden until they update it" });
    if (checked) await expect(keep).toBeChecked(); else await expect(keep).not.toBeChecked();
    if (disabled) await expect(keep).toBeDisabled(); else await expect(keep).toBeEnabled();
    await expect(send).toBeDisabled(); // a note is required
    await note.fill("   ");
    await expect(send).toBeDisabled();
    await note.fill("x".repeat(1001));
    await expect(form.locator(".hfy-mod__count")).toHaveText("1001/1000");
    await expect(send).toBeDisabled();
    await note.fill("Which summer was this?");
    await expect(form.locator(".hfy-mod__count")).toHaveText("22/1000");
    await expect(send).toBeEnabled();
    expect((await box(send)).height).toBeGreaterThanOrEqual(43.5);
    await send.click();
    await expect(row(page, 1).getByRole("status").filter({ hasText: /^sent\.$/ })).toBeVisible();
    expect(s.moderation).toEqual([{ target: { kind: "post", id: ULID(1) }, action, note: "Which summer was this?", ...(hide === undefined ? {} : { hide }), version: T0 }]);
  });
}

test("a note with a phone number is held in the form (R-18), and a server refusal shows its line and keeps the form open", async ({ page }) => {
  const s = await stub(page, { viewer: "admin", posts: [asAdmin(post(1))] });
  await page.goto("/posts/", { waitUntil: "domcontentloaded" });
  await row(page, 1).getByRole("button", { name: /^moderate/ }).click();
  await page.getByRole("button", { name: "ask a question…", exact: true }).click();
  const form = page.locator('[data-hfy-ask="ask"]');
  await form.getByRole("textbox").fill("call me on 555-010-0199 please");
  await expect(form.locator("[data-hfy-guard]")).toBeVisible();
  await expect(form.getByRole("button", { name: "send" })).toBeDisabled();
  await form.getByRole("textbox").fill("Which summer was this?");
  s.refuse = { status: 409, error: "conflict" };
  await form.getByRole("button", { name: "send" }).click();
  await expect(page.locator("[data-hfy-mod-error]")).toHaveText("that changed while you were looking. reload and try again.");
  await expect(form.getByRole("textbox")).toHaveValue("Which summer was this?"); // the text is kept
  s.refuse = { status: 400, error: "self_moderation" };
  await form.getByRole("button", { name: "send" }).click();
  await expect(page.locator("[data-hfy-mod-error]")).toHaveText("that one is yours. withdraw or delete it instead.");
});

// ------------------------------------------------------------------------------------------------------------------- the author edits
test("the author's edit button opens an editor; saving sends the PATCH and the banner goes (the post is visible again)", async ({ page }) => {
  const s = await stub(page, { viewer: "author", posts: [asAuthor(post(1, { moderation: ASK }))] });
  await page.goto("/posts/", { waitUntil: "domcontentloaded" });
  await row(page, 1).getByRole("button", { name: "edit", exact: true }).click();
  const form = row(page, 1).locator("[data-hfy-mod-edit-form]");
  const body = form.getByRole("textbox");
  await expect(body).toBeFocused();
  await expect(body).toHaveValue("Synthetic post 1");
  await body.fill("Synthetic post 1, with names added");
  await form.getByRole("button", { name: "save" }).click();
  await expect(row(page, 1).locator("[data-hfy-mod-banner]")).toHaveCount(0);
  await expect(row(page, 1).getByRole("status").filter({ hasText: "saved. it's visible again." })).toBeVisible();
  expect(s.patches).toEqual([{ body: "Synthetic post 1, with names added" }]);
});

// ------------------------------------------------------------------------------------------------------------------- photos and stories
test("a post's photos each get a hide control (only the admin), and hiding one names the photo by its upload", async ({ page }) => {
  const s = await stub(page, {
    viewer: "admin",
    posts: [asAdmin(post(1, { subject: "I9001", attachments: [PHOTO_A, PHOTO_B] }))],
    after: (b) => asAdmin(post(1, { subject: "I9001", attachments: [PHOTO_A, { ...PHOTO_B, moderation: { hidden: true, by: ADMIN, at: T0 } }] })),
  });
  await page.goto("/posts/", { waitUntil: "domcontentloaded" });
  const photos = row(page, 1).locator(".iok-content-media > li");
  await expect(photos).toHaveCount(2);
  await expect(row(page, 1).locator("[data-hfy-post-kind='story']")).toHaveCount(0); // the li itself carries it
  await expect(feed(page).locator("li[data-hfy-post-kind='story']")).toHaveCount(1); // a post about a person is a story
  const second = photos.nth(1).getByRole("button", { name: /^moderate photo/ });
  await expect(second).toBeVisible();
  expect((await box(second)).height).toBeGreaterThanOrEqual(43.5);
  await second.click();
  const menu = page.getByRole("dialog", { name: "moderate" });
  await expect(menu.getByRole("button")).toHaveText(["hide photo"]); // a note is for the whole item, never one photo
  await menu.getByRole("button", { name: "hide photo" }).click();
  expect(s.moderation).toEqual([{ target: { kind: "photo", parent: { kind: "post", id: ULID(1) }, attachment: ULID(72) }, action: "hide", version: T0 }]);
  await expect(row(page, 1).getByRole("status").filter({ hasText: "photo hidden." })).toBeVisible();
  await expect(photos.nth(1)).toContainText("hidden photo");
  await photos.nth(1).getByRole("button", { name: /^moderate photo/ }).click();
  await expect(page.getByRole("dialog", { name: "moderate" }).getByRole("button")).toHaveText(["unhide photo"]);
});

test("the other member and the author get no photo control", async ({ browser }) => {
  for (const viewer of ["member", "author"]) {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    await stub(page, { viewer, posts: [(viewer === "author" ? asAuthor : (p) => p)(post(1, { attachments: [PHOTO_A] }))] });
    await page.goto("/posts/", { waitUntil: "domcontentloaded" });
    await expect(row(page, 1).locator(".iok-content-media > li")).toHaveCount(1);
    await page.waitForTimeout(300);
    await expect(page.locator("[data-hfy-moderate]")).toHaveCount(0);
    await ctx.close();
  }
});

// ------------------------------------------------------------------------------------------------------------------- comments
const comment = (n, over = {}) => ({ id: ULID(300 + n), threadId: `post:${ULID(1)}`, author: AUTHOR, body: `Synthetic comment ${n}`, created_at: T0, can: { edit: false, delete: false, react: false, moderate: false }, ...over });
const THREAD = `/posts/?id=${ULID(1)}`;
const commentsOf = (page) => page.locator("[data-hfy-comments]");
const item = (page, n) => commentsOf(page).locator(".io-comments-list > li", { hasText: `Synthetic comment ${n}` });

test("comments: the kit menu hides and asks through POST /api/moderation, only with can.moderate; unhide sits beside the badge", async ({ page }) => {
  const mine = comment(1, { can: { edit: false, delete: true, react: false, moderate: true } });
  const hid = comment(2, { moderation: HIDE, can: { edit: false, delete: true, react: false, moderate: true } });
  const shut = comment(3);
  const s = await stub(page, {
    viewer: "admin", posts: [post(1)], comments: [mine, hid, shut],
    after: (b) => ({ ...(b.target.id === hid.id ? hid : mine), moderation: b.action === "unhide" ? undefined : { ...ASK, note: b.note, state: b.action === "ask" ? "question" : "changes_requested", hidden: b.action !== "ask" || b.hide === true } }),
  });
  await page.goto(THREAD, { waitUntil: "domcontentloaded" });
  await expect(item(page, 1)).toBeVisible();
  await page.waitForTimeout(300);
  await expect(item(page, 3).locator(".io-comments-moderation")).toHaveCount(0); // no can.moderate, no control
  await expect(item(page, 2).locator("[data-hfy-mod-button='unhide']")).toBeVisible();
  // the sheet at 375: the kit's <details> is docked to the bottom, 56 px rows
  await item(page, 1).locator(".io-comments-moderation > summary").click();
  const menu = item(page, 1).locator(".io-comments-moderation");
  const b = await box(menu);
  expect(Math.round(b.x + b.width)).toBe(375);
  expect(Math.round(b.y + b.height)).toBe(812);
  for (const r of await menu.locator(".io-comments-actions > button").all()) expect(Math.round((await box(r)).height)).toBe(56);
  await menu.getByRole("button", { name: "ask a question…" }).click();
  const note = menu.getByRole("textbox", { name: "note to the author" });
  await expect(menu.getByRole("checkbox")).not.toBeChecked();
  await note.fill("Which summer was this?");
  await menu.getByRole("button", { name: "send" }).click();
  await expect(commentsOf(page).getByRole("status").filter({ hasText: /^sent\.$/ })).toBeVisible();
  expect(s.moderation[0]).toEqual({ target: { kind: "comment", id: mine.id, thread: `post:${ULID(1)}` }, action: "ask", note: "Which summer was this?", hide: false, version: T0 });
  // one-tap unhide presses the kit's own unhide
  s.moderation.length = 0;
  await item(page, 2).locator("[data-hfy-mod-button='unhide']").click();
  await expect.poll(() => s.moderation.length).toBe(1);
  expect(s.moderation[0]).toMatchObject({ target: { kind: "comment", id: hid.id }, action: "unhide" });
  expect(await noHScroll(page)).toBe(true);
});

test("comments: the author sees the banner with the note and an edit button that opens the kit's editor; others see nothing", async ({ browser }) => {
  const asked = comment(1, { moderation: ASK, can: { edit: true, delete: true, react: false, moderate: false } });
  for (const viewer of ["author", "member"]) {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    await stub(page, { viewer, posts: [post(1)], comments: viewer === "author" ? [asked] : [comment(2)] });
    await page.goto(THREAD, { waitUntil: "domcontentloaded" });
    if (viewer === "author") {
      const li = item(page, 1);
      await expect(li.locator(".io-comments-banner")).toHaveText("Ada Example asked: Please add who is in the photo. — edit it to show it again.");
      await li.locator("[data-hfy-mod-button='edit']").click();
      await expect(li.locator("textarea")).toBeVisible();
      await expect(li.locator("[data-hfy-mod-button='edit']")).toHaveCount(0);
    } else {
      await expect(item(page, 2)).toBeVisible();
      await page.waitForTimeout(300);
      await expect(page.locator(".io-comments-banner, .io-comments-badge, .io-comments-moderation, [data-hfy-mod-button]")).toHaveCount(0);
    }
    await ctx.close();
  }
});

test("comments: a comment photo has its own hide control, only for an admin with can.moderate", async ({ page }) => {
  const withPhoto = comment(1, { can: { edit: false, delete: true, react: false, moderate: true }, attachments: [{ id: "att1", url: `/uploads/comments/${ULID(80)}/c.jpg`, kind: "image", mime: "image/jpeg" }] });
  const s = await stub(page, { viewer: "admin", posts: [post(1)], comments: [withPhoto] });
  await page.goto(THREAD, { waitUntil: "domcontentloaded" });
  const btn = item(page, 1).getByRole("button", { name: /^moderate photo/ });
  await expect(btn).toBeVisible();
  await btn.click();
  await page.getByRole("dialog", { name: "moderate" }).getByRole("button", { name: "hide photo" }).click();
  await expect.poll(() => s.moderation.length).toBe(1);
  expect(s.moderation[0]).toEqual({ target: { kind: "photo", parent: { kind: "comment", id: withPhoto.id, thread: `post:${ULID(1)}` }, attachment: "att1" }, action: "hide", version: T0 });
});

// ------------------------------------------------------------------------------------------------------------------- axe and sizes
test("axe is clean on the admin's feed with the menu, the ask form and a hidden post open (375 px)", async ({ page }) => {
  await stub(page, { viewer: "admin", posts: [asAdmin(post(1, { moderation: ASK })), asAdmin(post(2, { attachments: [PHOTO_A] }))] });
  await page.goto("/posts/", { waitUntil: "domcontentloaded" });
  await expect(row(page, 2).getByRole("button", { name: /^moderate/ }).first()).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await row(page, 2).getByRole("button", { name: "moderate, post" }).click();
  await page.getByRole("button", { name: "ask for changes…" }).click();
  await page.getByRole("textbox", { name: "note to the author" }).fill("A synthetic note.");
  expect(await axeViolations(page)).toEqual([]);
  expect(await noHScroll(page)).toBe(true);
  for (const loc of [page.getByRole("button", { name: "send" }), page.getByRole("button", { name: "cancel" }), page.locator(".hfy-mod__check"), row(page, 1).locator("[data-hfy-mod-unhide]")]) expect((await box(loc)).height).toBeGreaterThanOrEqual(43.5);
});

test("axe is clean and nothing scrolls sideways at 1280 px with the menu open", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await stub(page, { viewer: "admin", posts: [asAdmin(post(1, { moderation: HIDE })), asAdmin(post(2))] });
  await page.goto("/posts/", { waitUntil: "domcontentloaded" });
  await row(page, 2).getByRole("button", { name: "moderate, post" }).click();
  await expect(page.getByRole("dialog", { name: "moderate" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  expect(await noHScroll(page)).toBe(true);
});

test("axe is clean on the admin's thread with a hidden comment, its unhide, and the kit's sheet open (375 px)", async ({ page }) => {
  const hid = comment(2, { moderation: ASK, can: { edit: false, delete: true, react: false, moderate: true } });
  const open = comment(1, { can: { edit: false, delete: true, react: false, moderate: true } });
  await stub(page, { viewer: "admin", posts: [post(1)], comments: [open, hid] });
  await page.goto(THREAD, { waitUntil: "domcontentloaded" });
  const unhide = item(page, 2).locator("[data-hfy-mod-button='unhide']");
  await expect(unhide).toBeVisible();
  expect((await box(unhide)).height).toBeGreaterThanOrEqual(43.5);
  expect(await axeViolations(page)).toEqual([]);
  await item(page, 1).locator(".io-comments-moderation > summary").click();
  await item(page, 1).getByRole("button", { name: "ask for changes…" }).click();
  await expect(item(page, 1).getByRole("checkbox")).toBeChecked();
  expect((await box(item(page, 1).locator("label.io-comments-counter"))).height).toBeGreaterThanOrEqual(43.5);
  expect(await axeViolations(page)).toEqual([]);
  expect(await noHScroll(page)).toBe(true);
  // a press outside closes the sheet, as does Escape
  await page.mouse.click(10, 10);
  await expect(item(page, 1).locator(".io-comments-moderation")).not.toHaveAttribute("open", "");
});
