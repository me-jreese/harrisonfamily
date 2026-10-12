// HFY-TSK-066: personV2 at 375px. /api, /auth/session and /person/<id>.json are stubbed by route interception; synthetic data only.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-synthetic.json", import.meta.url), "utf8"));
const ME = { id: "I9002", label: "Sam Example" };
const T0 = "2026-01-01T00:00:00.000Z";
const mkComment = (id, author, body, can) => ({ id, threadId: "person:I9001", author, body, created_at: T0, can });

async function stub(page, { signedIn = true } = {}) {
  const state = { comments: [mkComment("01HZZZZZZZZZZZZZZZZZZZZZ01", { id: "I9003", label: "Ann Other" }, "Hello @I0044 from the family", { edit: false, delete: false, react: signedIn })], reactions: {}, posts: 0, reacts: 0 };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/person/I9001.json", (r) => r.fulfill({ json: PERSON }));
  await page.route("**/person/*.json", (r) => (r.request().url().includes("I9001") ? r.fallback() : r.fulfill({ json: [] })));
  await page.route("**/auth/session", (r) => r.fulfill({ json: signedIn ? { authenticated: true, sub: ME.id, grampsId: ME.id, label: ME.label } : { authenticated: false } }));
  await page.route("**/api/comments**", async (r) => {
    const req = r.request();
    const u = new URL(req.url());
    const m = u.pathname.match(/^\/api\/comments(?:\/([^/]+)\/react)?$/);
    if (req.method() === "GET") return r.fulfill({ json: { thread: { id: "person:I9001", topic: "comments", comments: state.comments, reactions: state.reactions } } });
    if (req.method() === "POST" && !m[1]) {
      state.posts += 1;
      const c = mkComment(`01HZZZZZZZZZZZZZZZZZZZZZ${10 + state.posts}`, ME, req.postDataJSON().body, { edit: true, delete: true, react: false });
      state.comments.push(c);
      return r.fulfill({ status: 201, json: c });
    }
    if (req.method() === "POST" && m[1]) {
      state.reacts += 1;
      const emoji = req.postDataJSON().emoji;
      const key = `comment:${m[1]}`;
      const mine = (state.reactions[key] ??= []);
      const i = mine.findIndex((x) => x.by === ME.id);
      if (i >= 0 && mine[i].emoji === emoji) { mine.splice(i, 1); return r.fulfill({ json: { removed: true } }); }
      const reaction = { emoji, by: ME.id, created_at: T0 };
      if (i >= 0) mine.splice(i, 1);
      mine.push(reaction);
      return r.fulfill({ json: { removed: false, reaction } });
    }
    return r.fulfill({ status: 204, body: "" });
  });
  await page.addInitScript(() => {
    sessionStorage.setItem("HFY_GATEWAY_SESSION_V1", JSON.stringify({ token: "synthetic", grampsId: "I9002", expiresAt: Date.now() + 3600e3, verifiedAt: Date.now() }));
  });
  return state;
}

test("flag on: md notes, comment list, post, react; 16px inputs, 44px targets, no h-scroll", async ({ page }) => {
  const state = await stub(page);
  await page.goto("/person/?id=I9001&hfy_flags=personV2", { waitUntil: "domcontentloaded" });
  const notes = page.locator("#hfy-notes-v2");
  await expect(notes.locator("h1")).toHaveText("Early life");
  await expect(notes.locator("strong")).toHaveText("Sam Example");
  await expect(notes.getByRole("link", { name: "ok" })).toHaveAttribute("rel", /noopener/);
  await expect(notes.locator("script")).toHaveCount(0);
  expect(await notes.locator('a[href^="javascript:"]').count()).toBe(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await expect(page.getByText("LEGACY NOTE")).toHaveCount(0);

  const comments = page.locator("[data-hfy-comments]");
  await expect(comments.getByText("Hello")).toBeVisible();
  await expect(comments.getByRole("heading", { name: "comments" })).toBeVisible();
  // Interface contract (f): the comments host is the LAST child of #person-content (after life, family, photos, stories).
  expect(await page.evaluate(() => document.getElementById("person-content").lastElementChild?.id)).toBe("hfy-person-comments");
  await expect(comments.locator("time").first()).toHaveAttribute("title", /^[a-z]+ \d{1,2}, \d{4}, \d{1,2}:\d{2} (am|pm)$/);
  await expect(comments.getByRole("link", { name: "I0044" })).toHaveAttribute("href", "/person/?id=I0044");
  await expect(page.locator("[data-hfy-signin]")).toHaveCount(0);

  const box = comments.getByRole("textbox");
  await box.fill("A new synthetic comment");
  const post = comments.getByRole("button", { name: /^post$/i });
  const [hb, hp] = await Promise.all([box.boundingBox(), post.boundingBox()]);
  expect(hb.height).toBeGreaterThanOrEqual(43.5);
  expect(Math.abs(hb.height - hp.height)).toBeLessThanOrEqual(1);
  expect(await box.evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16);
  await post.click();
  await expect(comments.getByRole("list").getByText("A new synthetic comment")).toBeVisible();
  expect(state.posts).toBe(1);
  await expect(comments.getByRole("status").filter({ hasText: /^posted$/ })).toBeVisible();
  await expect(comments.getByRole("status").filter({ hasText: /^posted$/ })).toHaveCount(0, { timeout: 5000 }); // 3 s, then gone

  const react = comments.getByRole("button", { name: /react/i }).first();
  await react.click();
  const emoji = comments.getByRole("button", { name: /^(\u{1F44D}|❤)/u }).first();
  await emoji.click();
  await expect.poll(() => state.reacts).toBe(1);
  await expect(comments.locator('[aria-pressed="true"]').first()).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("flag on, signed out: one sign-in line and one button, no thread mounted", async ({ page }) => {
  await stub(page, { signedIn: false });
  const asked = [];
  page.on("request", (q) => { if (q.url().includes("/api/comments")) asked.push(q.url()); });
  await page.goto("/person/?id=I9001&hfy_flags=personV2", { waitUntil: "domcontentloaded" });
  const comments = page.locator("[data-hfy-comments]");
  await expect(comments.getByText("sign in to leave a comment.")).toBeVisible();
  await expect(comments.getByRole("link")).toHaveCount(1);
  await expect(comments.getByRole("link", { name: "sign in" })).toHaveAttribute("href", /^\/auth\/login\?returnTo=/);
  await expect(comments.getByRole("textbox")).toHaveCount(0);
  await expect(comments.locator(".io-comments")).toHaveCount(0);
  expect(asked).toEqual([]);
});

test("flag off: page unchanged, no island loaded", async ({ page }) => {
  await stub(page);
  const loaded = [];
  page.on("request", (q) => { if (q.url().includes("/js/islands/person")) loaded.push(q.url()); });
  await page.goto("/person/?id=I9001&hfy_flags=-personV2", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("LEGACY NOTE")).toBeVisible();
  await page.waitForTimeout(500);
  expect(loaded).toEqual([]);
  expect(await page.locator("#hfy-notes-v2, [data-hfy-comments]").count()).toBe(0);
});
