// HFY design-system pass, QA round 1 fixes (blocker/major): each test pins one fixed defect at the widths QA measured it.
// Synthetic data only (fixtures/islands-look.json); /auth/session, /api/* and the data JSON are stubbed; everything off-host is aborted.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/qa-fixes.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const FX = JSON.parse(readFileSync(new URL("./fixtures/islands-look.json", import.meta.url), "utf8"));
const FLAGS = "hfy_flags=shellV2,postsV2,personV2,searchV2,notifyV2";
const GOLD = "rgb(255, 193, 7)";
const WIDTHS = [375, 688, 1024];
const at = (min) => new Date(Date.now() - min * 60e3).toISOString();
const TALL = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1600"><rect width="900" height="1600" fill="gray"/></svg>';
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function stub(page, { signedIn = true, cursor = null, ownComment = false } = {}) {
  const s = { pages: [], deletes: [], uploads: 0 };
  const posts = FX.posts.map(({ agoMin, ...p }) => ({ ...p, created_at: at(agoMin), updated_at: at(agoMin) }));
  posts[0] = { ...posts[0], attachments: [{ kind: "image", url: "/media/tall.svg", mime: "image/svg+xml", alt: "a tall photo", width: 900, height: 1600 }] };
  const comments = FX.comments.map(({ agoMin, ...c }) => ({ ...c, threadId: "x", created_at: at(agoMin) }));
  if (ownComment) comments.push({ id: "01HZZZZZZZZZZZZZZZZZZZZZ09", threadId: "x", author: FX.me, body: "Mine to delete.", created_at: at(5), can: { edit: true, delete: true, react: true } });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.route("**/auth/session", (r) => r.fulfill({ json: signedIn ? { authenticated: true, sub: FX.me.id, grampsId: FX.me.id, label: FX.me.label } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/media/tall.svg", (r) => r.fulfill({ contentType: "image/svg+xml", body: TALL }));
  await page.route(/\/person\/I\d+\.json/, (r) => r.fulfill({ json: FX.person }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: FX.manifest }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: FX.manifest.people.map((p) => ({ grampsId: p.grampsId, searchText: p.displayName.toLowerCase() })) } }));
  await page.route("**/api/uploads", (r) => { s.uploads += 1; const b = r.request().postDataJSON(); return r.fulfill({ status: 201, json: { uploadUrl: `http://127.0.0.1/put/photo`, publicUrl: `/media/tall.svg?u=${s.uploads}`, headers: { "Content-Type": b.contentType } } }); });
  await page.route("http://127.0.0.1/put/**", (r) => r.fulfill({ status: 200, body: "" }));
  await page.route(/\/api\/posts(\/[^/?]+)?(\?.*)?$/, (r) => {
    const u = new URL(r.request().url());
    if (r.request().method() === "DELETE") { s.deletes.push(u.pathname); return r.fulfill({ status: 204, body: "" }); }
    const id = u.pathname.split("/")[3];
    if (id) return r.fulfill({ json: posts.find((p) => p.id === id) ?? posts[0] });
    const subject = u.searchParams.get("subject");
    const c = u.searchParams.get("cursor");
    s.pages.push(c);
    const items = posts.filter((p) => !subject || p.subject === subject);
    if (c) return r.fulfill({ json: { items: [{ ...items[items.length - 1], id: "01JZZZZZZZZZZZZZZZZZZZZ001", body: "An older synthetic post." }], cursor: null } });
    return r.fulfill({ json: { items, cursor } });
  });
  await page.route("**/api/comments**", (r) => (r.request().method() === "GET" ? r.fulfill({ json: { thread: { id: "x", topic: "comments", comments, reactions: {} } } }) : (s.deletes.push(new URL(r.request().url()).pathname), r.fulfill({ status: 204, body: "" }))));
  await page.route("**/api/notifications/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path.endsWith("/vapid-public-key")) return r.fulfill({ json: { public_key: "AAAA" } });
    if (path.endsWith("/preferences")) return r.fulfill({ json: FX.preferences });
    return r.fulfill({ json: {} });
  });
  return s;
}

const ringOf = (loc) => loc.evaluate((el) => { const c = getComputedStyle(el); return { style: c.outlineStyle, width: c.outlineWidth, color: c.outlineColor, offset: c.outlineOffset, shadow: c.boxShadow }; });

// ---------------------------------------------------------------------------------------------------------------- posts
test("paging: a feed.v1 next_cursor renders 'show older posts' (44px) and it loads the next page", async ({ page }) => {
  const s = await stub(page, { cursor: "next" });
  await page.goto(`/posts/?${FLAGS}`, { waitUntil: "domcontentloaded" });
  const more = page.getByRole("button", { name: "show older posts" });
  await expect(more).toBeVisible();
  expect((await more.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await more.click();
  await expect(page.getByText("An older synthetic post.")).toBeVisible();
  expect(s.pages).toContain("next");
  await expect(more).toHaveCount(0);
});

for (const width of WIDTHS) {
  test(`posts at ${width}: avatar 32 beside name and time, one 44px footer row, photo capped at 4:5 (uncropped)`, async ({ page }) => {
    await stub(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/posts/?${FLAGS}`, { waitUntil: "domcontentloaded" });
    const row = page.locator(".hfy-posts__post").first();
    await expect(row.locator(".iok-content-media img")).toBeVisible();
    await page.waitForFunction(() => document.querySelector(".hfy-posts__post .iok-content-media img")?.complete);
    const m = await row.evaluate((li) => {
      const r = (el) => el.getBoundingClientRect();
      const av = li.querySelector(".hfy-posts__avatar");
      const meta = li.querySelector(".iok-content-meta");
      const name = meta.querySelector("span");
      const foot = li.querySelector(".hfy-posts__footer");
      const img = li.querySelector(".iok-content-media img");
      const list = li.querySelector(".iok-content-media");
      return { av: [r(av).width, r(av).height], avText: av.textContent, avBg: getComputedStyle(av).backgroundColor, sameRow: Math.abs(r(av).top + r(av).height / 2 - (r(name).top + r(name).height / 2)) < 4, nameRight: r(name).left > r(av).right, footH: r(foot).height, footItems: [...foot.children].map((c) => [c.textContent, Math.round(r(c).height), Math.round(r(c).top)]), img: [r(img).width, r(img).height], list: r(list).width, fit: getComputedStyle(img).objectFit };
    });
    expect(m.av).toEqual([32, 32]);
    expect(m.avText).toBe("T");
    expect(m.avBg).toBe("rgb(88, 182, 231)");
    expect(m.sameRow && m.nameRight, "avatar beside the name").toBe(true);
    expect(m.footH).toBeGreaterThanOrEqual(44);
    expect(m.footH).toBeLessThan(88); // ONE row
    expect(m.footItems.map((f) => f[0])).toEqual(["comments", "delete"]);
    expect(new Set(m.footItems.map((f) => f[2])).size, "comments and delete share the row").toBe(1);
    for (const f of m.footItems) expect(f[1]).toBeGreaterThanOrEqual(44);
    expect(m.img[1]).toBeLessThanOrEqual(m.list * 1.25 + 1); // max 4:5 of the column
    expect(m.img[0] / m.img[1]).toBeCloseTo(900 / 1600, 2); // uncropped
    expect(m.fit).toBe("contain");
    await expect(page.getByRole("link", { name: "comments on Test Member's post" })).toHaveAttribute("href", /\/posts\/\?id=/);
  });
}

test("home, signed out: the public timeline renders nothing (no gate, no alert, no /api/posts)", async ({ page }) => {
  const s = await stub(page, { signedIn: false });
  await page.goto(`/?${FLAGS},authV2`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await expect(page.locator("#hfy-timeline")).toBeAttached();
  await expect(page.locator("#hfy-timeline *")).toHaveCount(0);
  await expect(page.locator("main [role=alert]")).toHaveCount(0);
  expect(s.pages).toEqual([]);
});

for (const width of WIDTHS) {
  test(`own page at ${width}: composer is one row (input 44 / photo 44 / post 44), no browser file picker copy; my posts line up with the sections`, async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/person/?id=${FX.me.id}&${FLAGS}`, { waitUntil: "domcontentloaded" });
    const mine = page.locator("#hfy-my-posts");
    const box = mine.getByRole("textbox", { name: /post a photo or a line/ });
    await expect(box).toBeVisible();
    await expect(box).toHaveAttribute("placeholder", "post a photo or a line");
    const photo = mine.getByRole("button", { name: "add a photo" }).first();
    const post = mine.getByRole("button", { name: "post" });
    const [b, p, q] = await Promise.all([box.boundingBox(), photo.boundingBox(), post.boundingBox()]);
    for (const x of [b, p, q]) expect(Math.round(x.height)).toBe(44);
    expect(Math.round(b.y)).toBe(Math.round(p.y));
    expect(Math.round(p.y)).toBe(Math.round(q.y));
    expect(b.x + b.width).toBeLessThanOrEqual(p.x);
    expect(p.x + p.width).toBeLessThanOrEqual(q.x);
    // the native picker is never shown and is out of the tab order / AT tree; the HFY button opens it
    const file = mine.locator('input[type="file"]');
    await expect(file).toBeHidden();
    await expect(file).toHaveAttribute("tabindex", "-1");
    // headings share the page gutter
    const xs = await page.evaluate(() => [...document.querySelectorAll("#person-content h2")].filter((h) => h.getBoundingClientRect().width > 1).map((h) => Math.round(h.getBoundingClientRect().left)));
    expect(xs.length).toBeGreaterThanOrEqual(5); // life, family, photos, stories, share something (+ comments)
    expect(new Set(xs).size, `section heading x: ${xs}`).toBe(1);
    // attach a photo: thumbnail, a visible alt hint, the done ping
    await file.setInputFiles({ name: "garden.png", mimeType: "image/png", buffer: PNG });
    await expect.poll(() => s.uploads).toBe(1);
    await expect(mine.locator(".iok-content-attachment img.hfy-posts__thumb")).toHaveCount(1);
    await expect(mine.locator(".iok-content-attachment input").first()).toHaveAttribute("placeholder", "describe the photo");
    await expect(mine.getByRole("status").filter({ hasText: "got it. it's in the gallery." })).toBeVisible();
    await expect(mine.getByText(/choose file|no file chosen/i)).toHaveCount(0);
  });
}

// ------------------------------------------------------------------------------------------------------------- comments
test("comments: delete asks 'delete this comment?' inline (keep focused); keep sends nothing, delete sends the DELETE", async ({ page }) => {
  const s = await stub(page, { ownComment: true });
  await page.goto(`/person/?id=${FX.me.id}&${FLAGS}`, { waitUntil: "domcontentloaded" });
  const item = page.locator("[data-hfy-comments] .io-comments-list > li", { hasText: "Mine to delete." });
  await expect(item).toBeVisible();
  await item.getByRole("button", { name: "delete", exact: true }).click();
  const ask = item.getByRole("group", { name: "delete this comment?" });
  await expect(ask).toBeVisible();
  await expect(ask.getByRole("button", { name: "keep" })).toBeFocused();
  for (const b of await ask.getByRole("button").all()) expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await expect(item.locator(".io-comments-actions")).toBeHidden();
  await ask.getByRole("button", { name: "keep" }).click();
  await expect(ask).toHaveCount(0);
  await expect(item.getByRole("button", { name: "delete", exact: true })).toBeFocused();
  expect(s.deletes).toEqual([]);
  await item.getByRole("button", { name: "delete", exact: true }).click();
  await item.getByRole("group", { name: "delete this comment?" }).getByRole("button", { name: "delete", exact: true }).click();
  await expect.poll(() => s.deletes.some((d) => d.includes("/api/comments"))).toBe(true);
});

// -------------------------------------------------------------------------------------------------------- notifications
for (const width of WIDTHS) {
  test(`notifications at ${width}: a switch never moves when toggled; the selected segment's ring is outside it, on the surface`, async ({ page }) => {
    await stub(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/me/notifications/?${FLAGS}`, { waitUntil: "domcontentloaded" });
    const rows = page.locator(".hfy-notify .iok-notify-row");
    await expect(rows.first()).toBeVisible();
    const xs = await rows.evaluateAll((els) => els.map((r) => Math.round(r.querySelector(".iok-notify-switch").getBoundingClientRect().right)));
    expect(new Set(xs).size, `switch right edges ${xs}`).toBe(1);
    const sw = rows.nth(1).locator(".iok-notify-switch");
    const before = await sw.boundingBox();
    await sw.click();
    await page.waitForTimeout(150);
    const after = await sw.boundingBox();
    expect(Math.round(after.x)).toBe(Math.round(before.x));
    expect(await sw.evaluate((e) => getComputedStyle(e).borderTopLeftRadius)).toBe("999px");
    const seg = page.locator('.hfy-notify .iok-notify-seg button[aria-checked="true"]').first();
    await seg.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    const focused = page.locator(".hfy-notify .iok-notify-seg button:focus-visible");
    if (await focused.count()) {
      const r = await ringOf(focused);
      expect(r).toMatchObject({ style: "solid", width: "2px", color: GOLD, offset: "2px" });
    } else {
      const r = await ringOf(seg);
      expect(r.offset).toBe("2px");
    }
    expect(await page.locator(".hfy-notify .iok-notify-seg").first().evaluate((e) => getComputedStyle(e).overflow)).toBe("visible");
    expect(await page.locator(".hfy-page h1").evaluate((e) => getComputedStyle(e).fontSize)).toBe(width < 688 ? "36px" : "48px");
  });
}

test("notifications signed out: only the neutral gate and a 44px sign in; no nudge, no settings, no push prompt", async ({ page }) => {
  await stub(page, { signedIn: false });
  await page.addInitScript(() => { window.__perm = 0; if (window.Notification) window.Notification.requestPermission = () => { window.__perm += 1; return Promise.resolve("default"); }; });
  await page.goto(`/me/notifications/?${FLAGS},authV2`, { waitUntil: "domcontentloaded" });
  const gate = page.locator(".hfy-notify [data-hfy-gate]");
  await expect(gate).toContainText("this page is family-only. sign in to see it.");
  await expect(gate).toHaveAttribute("role", "status");
  const signIn = gate.getByRole("link", { name: "sign in" });
  expect((await signIn.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await expect(signIn).toHaveAttribute("href", /^\/auth\/login\?returnTo=%2Fme%2Fnotifications%2F/);
  await expect(page.locator(".hfy-notify .iok-notify-nudge, .hfy-notify .iok-notify-row, .hfy-notify [role=switch], .hfy-notify [role=alert]")).toHaveCount(0);
  expect(await page.evaluate(() => window.__perm)).toBe(0);
});

// --------------------------------------------------------------------------------------------------------------- search
for (const width of [688, 1024]) {
  test(`search at ${width}: the Cloudscape row-1 input and Sort trigger take the one gold 2px ring; options are on-brand`, async ({ page }) => {
    await stub(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/search/?q=a&${FLAGS}`, { waitUntil: "domcontentloaded" });
    const input = page.locator("#hfy-search-v2 .io-search__row1 input").first();
    await expect(input).toBeVisible();
    await input.focus();
    expect(await ringOf(input)).toMatchObject({ style: "solid", width: "2px", color: GOLD, offset: "2px", shadow: "none" });
    const look = await input.evaluate((e) => { const c = getComputedStyle(e); return { font: c.fontFamily, size: c.fontSize, bg: c.backgroundColor, h: e.getBoundingClientRect().height }; });
    expect(look.font).toMatch(/^"?Source Sans 3/);
    expect(look).toMatchObject({ size: "16px", bg: "rgb(13, 12, 10)", h: 44 });
    await page.keyboard.type("b");
    const option = page.locator('[class*="awsui_options-list_"] [role="option"]').first();
    await expect(option).toBeVisible();
    const o = await option.evaluate((e) => { const c = getComputedStyle(e); return { font: c.fontFamily, size: c.fontSize, color: c.color }; });
    expect(o.font).toMatch(/^"?Source Sans 3/);
    expect(o.size).toBe("16px");
    expect(o.color).toBe("rgb(250, 246, 238)");
    await page.keyboard.press("Escape");
    const sort = page.locator("#hfy-search-v2 .io-search__cell--sort button").first();
    await sort.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(sort).toBeFocused();
    expect(await ringOf(sort)).toMatchObject({ style: "solid", width: "2px", color: GOLD, offset: "2px", shadow: "none" });
  });
}

test("search on a coarse pointer: Cloudscape options are 44px at 16px; the filter sheet's token controls are 44px", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await stub(page);
  await page.goto(`/search/?q=${encodeURIComponent(FX.manifest.people[0].displayName.split(" ")[0])}&${FLAGS}`, { waitUntil: "domcontentloaded" });
  await page.locator("#hfy-search-v2 .io-search__row2 button").first().click();
  const sheet = page.locator(".io-sheet.io-search-scope");
  await expect(sheet).toBeVisible();
  const small = await sheet.evaluate((s) => [...s.querySelectorAll("input, button")].filter((e) => e.getBoundingClientRect().width > 0).map((e) => ({ t: (e.getAttribute("aria-label") || e.textContent || e.placeholder || "").trim().slice(0, 24), h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width, size: parseFloat(getComputedStyle(e).fontSize) })).filter((x) => x.h < 43.5 || x.w < 43.5 || x.size < 16));
  expect(small).toEqual([]);
  await sheet.locator("input").first().focus();
  await page.keyboard.type("b");
  const option = page.locator('[role="option"]').first();
  if (await option.count()) {
    const o = await option.evaluate((e) => ({ h: e.getBoundingClientRect().height, size: getComputedStyle(e).fontSize }));
    expect(o.h).toBeGreaterThanOrEqual(43.5);
    expect(o.size).toBe("16px");
  }
  await ctx.close();
});
