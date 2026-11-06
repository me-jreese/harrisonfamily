// HFY-TSK-188 (R-27, R-28; BRD2 section 8): the person page's social row, capped sections and "older" paging, with contribV1 on
// (?hfy_flags=) and off (the default). /auth/session, /api/comments, /api/posts and /person/<id>.json are stubbed by route interception;
// every name, id and sentence is synthetic.
//   HFY_SITE=<dir> PW_PORT=<port> PW_CHANNEL=chromium-headless-shell npx playwright test tests/person-social.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-synthetic.json", import.meta.url), "utf8"));
const OWNER = { id: "I9001", label: "Test Person" };
const VISITOR = { id: "I9002", label: "Sam Example" };
const ANN = { id: "I9003", label: "Ann Other" };
const T0 = "2026-01-01T00:00:00.000Z";
const ULID = (n) => `01JZZZZZZZZZZZZZZZZZZZ${String(n).padStart(4, "0")}`;
const ON = "/person/?id=I9001&hfy_flags=personV2,postsV2,contribV1";
const OFF = "/person/?id=I9001&hfy_flags=personV2,postsV2";

const comment = (n) => ({ id: ULID(n), threadId: "person:I9001", author: ANN, body: `Synthetic comment number ${n}. It says something short and kind about the day.`, created_at: T0, can: { edit: false, delete: false, react: true } });
const story = (n) => ({ id: ULID(n), type: "post", author: ANN, subject: "I9001", body: `Synthetic story number ${n}, told in a few plain words so the card has some height to it.`, attachments: [], visibility: "published", created_at: T0, updated_at: T0, can: { edit: false, delete: false, publish: false } });

async function stub(page, { me = VISITOR, comments = 30, stories = 12, person = PERSON } = {}) {
  const s = { me, commentGets: [], postGets: [], commentPosts: [], external: [] };
  const all = Array.from({ length: comments }, (_, i) => comment(i + 1)); // 1 is the oldest
  const tales = Array.from({ length: stories }, (_, i) => story(100 + i + 1));
  page.on("request", (q) => { if (new URL(q.url()).hostname !== "127.0.0.1") s.external.push(q.url()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.route("**/person/I9001.json", (r) => r.fulfill({ json: person }));
  await page.route("**/person/*.json", (r) => (r.request().url().includes("I9001") ? r.fallback() : r.fulfill({ json: [] })));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: me.id, grampsId: me.id, label: me.label } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { id: me.id, label: me.label, admin: false, can: { moderate: false, graduate: false, approve: false } } }));
  await page.route("**/api/comments**", (r) => {
    const req = r.request();
    const u = new URL(req.url());
    if (req.method() === "GET") {
      const order = u.searchParams.get("order") || "asc";
      const limit = Number(u.searchParams.get("limit") || 50);
      const from = Number(u.searchParams.get("cursor") || 0);
      s.commentGets.push({ order, limit, cursor: u.searchParams.get("cursor") });
      const sorted = order === "desc" ? [...all].reverse() : all;
      const page_ = sorted.slice(from, from + limit);
      const next = from + limit < sorted.length ? String(from + limit) : undefined;
      return r.fulfill({ json: { thread: { id: "person:I9001", topic: "comments", comments: page_, reactions: {} }, ...(next ? { cursor: next } : {}) } });
    }
    if (req.method() === "POST") {
      const b = req.postDataJSON();
      s.commentPosts.push(b);
      const c = { id: ULID(900 + s.commentPosts.length), threadId: b.subject, author: me, body: b.body, created_at: T0, can: { edit: true, delete: true, react: false } };
      all.push(c);
      return r.fulfill({ status: 201, json: c });
    }
    return r.fulfill({ status: 204, body: "" });
  });
  await page.route(/\/api\/posts(\/[^/?]+)?(\?.*)?$/, (r) => {
    const req = r.request();
    const u = new URL(req.url());
    if (req.method() !== "GET") return r.fulfill({ status: 204, body: "" });
    const limit = Number(u.searchParams.get("limit") || 20);
    const from = Number(u.searchParams.get("cursor") || 0);
    s.postGets.push({ limit, subject: u.searchParams.get("subject"), visibility: u.searchParams.get("visibility"), cursor: u.searchParams.get("cursor") });
    const sorted = [...tales].reverse(); // newest first
    const next = from + limit < sorted.length ? String(from + limit) : null;
    return r.fulfill({ json: { items: sorted.slice(from, from + limit), cursor: next } });
  });
  await page.addInitScript((id) => {
    sessionStorage.setItem("HFY_GATEWAY_SESSION_V1", JSON.stringify({ token: "synthetic", grampsId: id, expiresAt: Date.now() + 3600e3, verifiedAt: Date.now() }));
  }, me.id);
  return s;
}

const thread = (page) => page.locator("#hfy-person-comments");
const items = (page) => thread(page).locator(".io-comments-list > li");
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const cap = (loc) => loc.evaluate((el) => parseFloat(getComputedStyle(el).maxHeight));
const inertCount = (loc) => loc.evaluateAll((els) => els.filter((e) => e.hasAttribute("inert") && e.getAttribute("aria-hidden") === "true").length);

async function open(page, url = ON, size = { width: 375, height: 812 }) {
  await page.setViewportSize(size);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(thread(page).locator(".io-comments-list")).toBeAttached();
  await expect(items(page).first()).toBeAttached();
}

// ---- AC1: the hosts --------------------------------------------------------------------------------------------------------------------
test("contribV1 on: #hfy-person-social is filled with the comments and the contributions host, and is the last child", async ({ page }) => {
  await stub(page);
  await open(page);
  const social = page.locator("#hfy-person-social");
  await expect(social).toBeVisible();
  expect(await page.evaluate(() => document.getElementById("person-content").lastElementChild.id)).toBe("hfy-person-social");
  expect(await social.evaluate((el) => [...el.querySelector(".hfy-social").children].map((c) => c.id))).toEqual(["hfy-person-comments", "hfy-person-contributions"]);
  await expect(social.getByRole("heading", { name: "comments" })).toBeVisible();
  await expect(social.getByRole("heading", { name: "contributions" })).toBeVisible();
  expect(await page.locator("#person-content > #hfy-person-comments").count(), "the comments host is no longer a sibling of the social host").toBe(0);
});

test("contribV1 off: the old structure stays, and the comments button reads 'show more comments'", async ({ page }) => {
  const s = await stub(page, { comments: 60 }); // the old thread asks for 50 at a time, so 60 leaves a second page
  await open(page, OFF);
  expect(await page.evaluate(() => [...document.getElementById("person-content").children].slice(-2).map((el) => el.id))).toEqual(["hfy-person-comments", "hfy-person-social"]);
  await expect(page.locator("#hfy-person-social")).toBeHidden();
  expect(await page.locator("#hfy-person-contributions").count()).toBe(0);
  expect(s.commentGets[0]).toMatchObject({ order: "asc" });
  const more = page.locator("#hfy-person-comments").getByRole("button", { name: "show more comments" });
  await expect(more).toBeVisible();
  await expect(page.locator("#hfy-person-comments").getByRole("button", { name: /show older/ })).toHaveCount(0);
  await expect(page.locator("[data-hfy-capped]")).toHaveCount(0);
});

// ---- AC2: CappedSection ----------------------------------------------------------------------------------------------------------------
test("the cap is 448 px below 43rem and 576 px from 43rem; items below it are inert and aria-hidden", async ({ page }) => {
  await stub(page);
  await open(page);
  const list = thread(page).locator(".io-comments-list");
  await expect.poll(() => cap(list)).toBe(448);
  await expect.poll(() => list.evaluate((el) => el.clientHeight)).toBe(448);
  expect(await list.evaluate((el) => getComputedStyle(el).overflow)).toBe("hidden");
  const total = await items(page).count();
  expect(total).toBe(8);
  const hidden = await inertCount(items(page));
  expect(hidden, "some of the 8 loaded comments start below the cap").toBeGreaterThan(0);
  expect(hidden).toBeLessThan(total);
  // exactly the items whose top is at or past the cap are inert; the rest are not
  const flags = await items(page).evaluateAll((els) => { const top = els[0].parentElement.getBoundingClientRect().top; return els.map((e) => ({ below: e.getBoundingClientRect().top - top >= 447.5, inert: e.hasAttribute("inert"), hidden: e.getAttribute("aria-hidden") })); });
  for (const f of flags) { expect(f.inert).toBe(f.below); expect(f.hidden).toBe(f.below ? "true" : null); }
  // the composer is not part of the clipped list
  await expect(thread(page).getByRole("textbox", { name: "say something" })).toBeVisible();
  // 43rem and up: 576 px
  await page.setViewportSize({ width: 768, height: 900 });
  await expect.poll(() => cap(list)).toBe(576);
  await expect.poll(() => list.evaluate((el) => el.clientHeight)).toBe(576);
  expect(await noHScroll(page)).toBe(true);
});

test("'show older comments' first reveals clipped items, then fetches the next page (30 comments)", async ({ page }) => {
  const s = await stub(page);
  await open(page);
  expect(s.commentGets).toEqual([{ order: "desc", limit: 8, cursor: null }]);
  const older = thread(page).getByRole("button", { name: "show older comments" });
  await expect(older).toBeVisible();
  expect((await older.boundingBox()).height).toBeGreaterThanOrEqual(44);
  const list = thread(page).locator(".io-comments-list");
  const before = await inertCount(items(page));
  await older.click();
  // the first press only raises the cap: nothing was fetched, fewer items are inert, and focus is on the first revealed item
  await expect.poll(() => cap(list)).toBe(896);
  expect(s.commentGets).toHaveLength(1);
  expect(await inertCount(items(page))).toBeLessThan(before);
  const focusIndex = await items(page).evaluateAll((els) => els.findIndex((e) => e === document.activeElement));
  expect(focusIndex, "focus moved onto a revealed item").toBeGreaterThan(0);
  expect(await items(page).nth(focusIndex).evaluate((e) => e.hasAttribute("inert"))).toBe(false);
  // keep pressing until everything loaded is visible: only then is the next page asked for
  for (let i = 0; i < 6 && s.commentGets.length === 1; i += 1) {
    await older.click();
    await page.waitForTimeout(50);
  }
  await expect.poll(() => s.commentGets.length).toBe(2);
  expect(s.commentGets[1]).toEqual({ order: "desc", limit: 8, cursor: "8" });
  await expect(items(page)).toHaveCount(16);
  // the cap rose after the page arrived, and focus is on the first new comment (the 9th)
  await expect.poll(() => items(page).nth(8).evaluate((e) => document.activeElement === e)).toBe(true);
  expect(await items(page).nth(8).evaluate((e) => e.hasAttribute("inert"))).toBe(false);
  // the list keeps growing in the page; when the last page is in and visible the button is gone
  for (let i = 0; i < 40 && (await older.count()) > 0; i += 1) {
    await older.click();
    await page.waitForTimeout(60);
  }
  await expect(items(page)).toHaveCount(30);
  await expect(older).toHaveCount(0);
  expect(await inertCount(items(page))).toBe(0);
  expect(await noHScroll(page)).toBe(true);
});

// ---- AC3: newest first, composer on top, anchors -----------------------------------------------------------------------------------------
test("comments are newest first with the composer on top, and a new comment goes to the top", async ({ page }) => {
  const s = await stub(page, { me: VISITOR });
  await open(page);
  await expect(items(page).first()).toContainText("Synthetic comment number 30.");
  expect(await thread(page).locator(".io-comments").evaluate((root) => {
    const form = root.querySelector(".io-comments-composer");
    const list = root.querySelector(".io-comments-list");
    return Boolean(form) && Boolean(list) && Boolean(form.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), "the composer comes before the list").toBe(true);
  await thread(page).getByRole("textbox", { name: "say something" }).fill("A brand new synthetic comment");
  await thread(page).locator("button.io-comments-post").click();
  await expect(items(page).first()).toContainText("A brand new synthetic comment");
  expect(s.commentPosts).toHaveLength(1);
});

test("#comment-<ulid> scrolls to and highlights that comment, loading pages until it is found", async ({ page }) => {
  const s = await stub(page);
  await open(page, `${ON}#comment-${ULID(12)}`);
  const target = page.locator(`#comment-${ULID(12)}`);
  await expect(target).toBeAttached();
  await expect(target).toHaveAttribute("data-hfy-target", "");
  await expect(target).toBeInViewport();
  expect(await target.evaluate((el) => !el.closest("[inert]"))).toBe(true);
  await expect(target).toContainText("Synthetic comment number 12.");
  expect(s.commentGets.length, "comment 12 is on the third page: the first plus two more").toBe(3);
  expect(await page.locator("[data-hfy-target]").count()).toBe(1);
  // a later hash change moves the highlight
  await page.evaluate((id) => { location.hash = `#comment-${id}`; }, ULID(28));
  await expect(page.locator(`#comment-${ULID(28)}`)).toHaveAttribute("data-hfy-target", "");
  await expect(page.locator("[data-hfy-target]")).toHaveCount(1);
});

test("an anchor to a comment that does not exist stops after 5 extra pages", async ({ page }) => {
  const s = await stub(page, { comments: 90 });
  await open(page, `${ON}#comment-${ULID(9999)}`);
  await expect.poll(() => s.commentGets.length).toBe(6);
  await page.waitForTimeout(400);
  expect(s.commentGets.length).toBe(6);
});

// ---- AC4: stories ----------------------------------------------------------------------------------------------------------------------
test("stories: every signed-in viewer sees published posts with subject=<id>, 5 per page, 'show older stories'; no composer for a visitor", async ({ page }) => {
  const s = await stub(page, { me: VISITOR });
  await open(page);
  const mine = page.locator("[data-hfy-my-posts]");
  await expect(mine.locator(".hfy-posts__list > li").first()).toBeAttached();
  expect(s.postGets[0]).toEqual({ limit: 5, subject: "I9001", visibility: "published", cursor: null });
  await expect(mine.locator(".hfy-posts__list > li")).toHaveCount(5);
  await expect(mine.locator(".iok-content-composer")).toHaveCount(0);
  await expect(mine.getByRole("heading", { name: "share something" })).toHaveCount(0);
  await expect(page.locator("#person-stories-section").getByRole("heading", { name: "stories" })).toBeVisible();
  const older = mine.getByRole("button", { name: "show older stories" });
  await expect(older).toBeVisible();
  const list = mine.locator(".hfy-posts__list");
  await expect.poll(() => cap(list)).toBe(448);
  // reveal what the cap clipped, then the next page of 5
  for (let i = 0; i < 8 && s.postGets.length === 1; i += 1) {
    await older.click();
    await page.waitForTimeout(50);
  }
  await expect.poll(() => s.postGets.length).toBe(2);
  expect(s.postGets[1]).toMatchObject({ limit: 5, subject: "I9001", visibility: "published", cursor: "5" });
  await expect(mine.locator(".hfy-posts__list > li")).toHaveCount(10);
  expect(await noHScroll(page)).toBe(true);
});

test("stories: the owner keeps the composer, and a person with no stories shows a visitor nothing extra", async ({ page }) => {
  const s = await stub(page, { me: OWNER, stories: 7 });
  await open(page);
  const mine = page.locator("[data-hfy-my-posts]");
  await expect(mine.getByRole("heading", { name: "share something" })).toBeVisible();
  await expect(mine.locator(".iok-content-composer")).toBeVisible();
  expect(s.postGets[0]).toMatchObject({ limit: 5, subject: "I9001" });
  await expect(mine.locator(".hfy-posts__list > li").first()).toBeAttached();
});

test("stories: with contribV1 off only the owner sees the section, 20 to a page, as before", async ({ page }) => {
  const s = await stub(page, { me: VISITOR });
  await open(page, OFF);
  await page.waitForTimeout(300);
  await expect(page.locator("[data-hfy-my-posts]")).toHaveCount(0);
  expect(s.postGets.map((g) => g.limit).every((l) => l === 20)).toBe(true);
});

test("stories: a visitor with no stories sees no empty state of their own", async ({ page }) => {
  const s = await stub(page, { me: VISITOR, stories: 0 });
  await open(page);
  await expect.poll(() => s.postGets.length).toBe(1);
  await expect(page.locator(".hfy-posts__feed [data-hfy-skeleton]")).toHaveCount(0);
  await expect(page.locator("[data-hfy-my-posts] [data-hfy-empty]")).toHaveCount(0);
});

// ---- AC5: layout, axe ------------------------------------------------------------------------------------------------------------------
test("1280: two equal columns, tops aligned, and the same 576 px cap; 768 and 375 stack, with no horizontal scroll at 375", async ({ page }) => {
  await stub(page);
  await open(page, ON, { width: 1280, height: 900 });
  const comments = page.locator("#hfy-person-comments");
  const contributions = page.locator("#hfy-person-contributions");
  const [a, b] = [await comments.boundingBox(), await contributions.boundingBox()];
  expect(Math.abs(a.width - b.width), `widths ${a.width} and ${b.width}`).toBeLessThanOrEqual(1);
  expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
  expect(b.x).toBeGreaterThan(a.x + a.width - 1);
  await expect.poll(() => cap(page.locator("#hfy-person-comments .io-comments-list"))).toBe(576);
  for (const width of [768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => { const [x, y] = [await comments.boundingBox(), await contributions.boundingBox()]; return y.y > x.y + x.height - 1 && Math.abs(y.x - x.x) <= 1; }, { message: `stacked at ${width}` }).toBe(true);
    const [x, y] = [await comments.boundingBox(), await contributions.boundingBox()];
    expect(Math.abs(x.width - y.width)).toBeLessThanOrEqual(1);
  }
  expect(await noHScroll(page)).toBe(true);
});

test("axe: the social row is clean with the flag on, at 375 and 1280", async ({ page }) => {
  await stub(page);
  await open(page);
  expect(await axeViolations(page, { include: "#hfy-person-social" })).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await axeViolations(page, { include: "#hfy-person-social" })).toEqual([]);
  expect(await axeViolations(page, { include: "#person-stories-section" })).toEqual([]);
});

// ---- AC6: notes use the HFY SanitizePolicy ----------------------------------------------------------------------------------------------
test("a record note: no external image is requested or drawn and mailto links are dropped; https links stay", async ({ page }) => {
  const person = { ...PERSON, notes: [{ raw: "# A note\n\nSee ![tracker](https://tracker.example.test/pixel.png) and [write](mailto:someone@example.test) and [site](https://example.com/x). Also [rel](/person/?id=I9002).", html: "<p>LEGACY NOTE</p>" }] };
  const s = await stub(page, { person });
  for (const url of [ON, OFF]) {
    s.external.length = 0;
    await open(page, url);
    const note = page.locator("#hfy-notes-v2");
    await expect(note.getByRole("heading", { name: "A note" })).toBeVisible();
    expect(await note.locator("img").count()).toBe(0);
    expect(await note.locator('a[href^="mailto:"]').count()).toBe(0);
    await expect(note.getByRole("link", { name: "site" })).toHaveAttribute("href", "https://example.com/x");
    await expect(note.getByRole("link", { name: "site" })).toHaveAttribute("rel", /noopener/);
    await expect(note.getByRole("link", { name: "rel" })).toHaveAttribute("href", "/person/?id=I9002");
    expect(s.external.filter((u) => u.includes("tracker.example.test")), "the image host was never asked").toEqual([]);
  }
});

test("record notes are clipped at the stories cap with contribV1 on, and not clipped with it off", async ({ page }) => {
  const long = Array.from({ length: 14 }, (_, i) => ({ raw: `Synthetic note ${i + 1}. A few plain words, written for a test and no one else.`, html: "<p>LEGACY NOTE</p>" }));
  await stub(page, { person: { ...PERSON, notes: long } });
  await open(page, ON);
  const notes = page.locator("#hfy-notes-v2 .hfy-notes");
  await expect.poll(() => cap(notes)).toBe(448);
  await expect.poll(() => notes.evaluate((el) => el.clientHeight)).toBe(448);
  expect(await inertCount(notes.locator(":scope > .card"))).toBeGreaterThan(0);
  const more = page.locator("#hfy-notes-v2").getByRole("button", { name: "show more notes" });
  await expect(more).toBeVisible();
  await more.click();
  await expect.poll(() => cap(notes)).toBe(896);
  await open(page, OFF);
  await expect(page.locator("#hfy-notes-v2 .hfy-notes")).toHaveCount(0);
  await expect(page.locator("#hfy-notes-v2").getByText("Synthetic note 14.")).toBeVisible();
});
