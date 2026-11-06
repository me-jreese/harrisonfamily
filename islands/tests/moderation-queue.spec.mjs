// HFY-TSK-192 (hfy-moderation-queue-page; flag moderationV1): /me/moderation/ at 375 and 1280, axe clean, with a stubbed API: the open tab (kind, author, when,
// state, note, "open" and "unhide"), the closed tab paged, unhide through POST /api/moderation, the non-admin line, the signed-out line, the flag-off state
// (no bundle, no request, HFY-R8) and the hub's "moderation" row for admins. Synthetic people only.
// HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/moderation-queue.spec.mjs
import { test, expect } from "@playwright/test";
import { axeViolations } from "./axe.mjs";

const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]];
const ADMIN = "I9003";
const FLAGS = { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: false, profileLinks: false, recordSubsV1: false, accessRequests: false, moderationV1: true };
const NOW = Date.now();
const ago = (h) => new Date(NOW - h * 3600000).toISOString();
const ID = (n) => `01HZZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(2, "0")}`;
const item = (n, over = {}) => ({ target: { kind: "post", id: ID(n) }, state: "hidden", hidden: true, by: { id: ADMIN, label: "Example" }, at: ago(n), open: true, author: { id: `I90${n}`, label: `Sam Sample ${n}` }, href: `/posts/?id=${ID(n)}`, ...over });
const OPEN = [
  item(1),
  item(2, { target: { kind: "comment", id: ID(2), thread: "person:I9001" }, state: "changes_requested", note: "please take out the phone number.", href: `/person/?id=I9001#comment-${ID(2)}` }),
  item(3, { state: "question", hidden: false, note: "which year was this?" }),
];
const CLOSED_1 = Array.from({ length: 2 }, (_, i) => item(10 + i, { open: false, hidden: false, resolved_by: "author", resolved_at: ago(1) }));
const CLOSED_2 = [item(12, { open: false, hidden: false, resolved_by: ADMIN, resolved_at: ago(2) })];

async function stub(page, { flags = {}, admin = true, session = ADMIN, unhide = null } = {}) {
  const s = { calls: [], posts: [], bundles: [], meCalls: 0, open: [...OPEN] };
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { ...FLAGS, ...flags } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: session ? { authenticated: true, sub: session, grampsId: session, label: "Example" } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route(/\/js\/islands\/moderation-queue\./, (r) => { s.bundles.push(r.request().url()); return r.continue(); });
  await page.route("**/api/me", (r) => { s.meCalls += 1; return r.fulfill(session ? { json: { id: session, label: "Example", admin, can: {} } } : { status: 401, json: { error: "unauthenticated" } }); });
  await page.route(/\/api\/moderation/, async (r) => {
    const req = r.request();
    const u = new URL(req.url());
    const rec = { method: req.method(), query: Object.fromEntries(u.searchParams), body: req.postData() ? JSON.parse(req.postData()) : undefined };
    s.calls.push(rec);
    if (!admin) return r.fulfill({ status: 403, json: { error: "forbidden" } });
    if (req.method() === "POST") {
      s.posts.push(rec);
      if (unhide) { const a = await unhide(rec, s); if (a) return r.fulfill(a); }
      s.open = s.open.filter((x) => x.target.id !== rec.body.target.id);
      return r.fulfill({ json: { target: rec.body.target, moderation: null, item: {} } });
    }
    if (rec.query.state === "closed") return r.fulfill({ json: rec.query.cursor ? { items: CLOSED_2, cursor: null } : { items: CLOSED_1, cursor: "next" } });
    return r.fulfill({ json: { items: s.open, cursor: null } });
  });
  return s;
}
const open = async (page, opts, query = "") => {
  const s = await stub(page, opts);
  await page.goto(`/me/moderation/${query}`, { waitUntil: "domcontentloaded" });
  return s;
};
const items = (page) => page.locator("[data-hfy-items] > li");

test.describe("flag off", () => {
  test("no bundle is requested, the page keeps its note and no request is made (HFY-R8)", async ({ page }) => {
    const s = await open(page, { flags: { moderationV1: false } });
    await page.waitForTimeout(500);
    await expect(page.locator("[data-moderation-off]")).toHaveText("moderation isn't available yet.");
    expect(s.bundles).toEqual([]);
    expect(s.calls).toEqual([]);
  });
});

test("a non-admin sees one line and the queue is never asked for", async ({ page }) => {
  const s = await open(page, { admin: false });
  await expect(page.locator("[data-hfy-not-admin]")).toHaveText("this page is for the people who look after the site.");
  expect(s.calls).toEqual([]);
});

test("signed out: the sign-in line", async ({ page }) => {
  const s = await open(page, { session: null });
  await expect(page.locator("[data-hfy-gate]")).toContainText("sign in to see what's been moderated.");
  await expect(page.locator("[data-hfy-gate] a")).toHaveAttribute("href", /\/auth\/login\?returnTo=/);
  expect(s.calls).toEqual([]);
});

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("the open tab lists kind, author, when, state, note, open and unhide, and is axe clean", async ({ page }) => {
      const s = await open(page, {});
      await expect(page.locator("[data-hfy-modq-ready]")).toBeVisible();
      await expect(items(page)).toHaveCount(3);
      expect(s.calls[0].query).toMatchObject({ state: "open" });
      const first = items(page).nth(0);
      await expect(first).toContainText("post");
      await expect(first).toContainText("Sam Sample 1");
      await expect(first).toContainText("1 hr ago");
      await expect(first.locator("[data-hfy-modq-state]")).toHaveText("hidden");
      await expect(first.locator('[data-hfy-act="open"]')).toHaveAttribute("href", `/posts/?id=${ID(1)}`);
      await expect(first.locator('[data-hfy-act="unhide"]')).toHaveText("unhide");
      await expect(items(page).nth(1)).toContainText("please take out the phone number.");
      await expect(items(page).nth(1)).toContainText("comment");
      await expect(items(page).nth(2).locator('[data-hfy-act="unhide"]')).toHaveText("close");
      expect(await axeViolations(page)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    });

    test("unhide sends the unhide action for that target and the row leaves the list", async ({ page }) => {
      const s = await open(page, {});
      await items(page).nth(0).locator('[data-hfy-act="unhide"]').click();
      await expect(items(page)).toHaveCount(2);
      await expect(page.locator("[data-hfy-notice]")).toHaveText("unhidden.");
      expect(s.posts).toHaveLength(1);
      expect(s.posts[0].body).toMatchObject({ target: { kind: "post", id: ID(1) }, action: "unhide" });
      expect(s.posts[0].body.note).toBeUndefined();
    });

    test("a refused unhide keeps the row and says why", async ({ page }) => {
      await open(page, { unhide: async () => ({ status: 409, json: { error: "conflict" } }) });
      await items(page).nth(0).locator('[data-hfy-act="unhide"]').click();
      await expect(page.locator("[data-hfy-problem]")).toHaveText("that changed while you were looking. reload and try again.");
      await expect(items(page)).toHaveCount(3);
    });

    test("the closed tab is paged, has no unhide, and is axe clean", async ({ page }) => {
      const s = await open(page, {}, "?tab=closed");
      await expect(page.locator('[data-hfy-tab="closed"]')).toHaveAttribute("aria-current", "page");
      await expect(items(page)).toHaveCount(2);
      await expect(items(page).first().locator("[data-hfy-modq-state]")).toHaveText("closed");
      await expect(page.locator('[data-hfy-act="unhide"]')).toHaveCount(0);
      expect(await axeViolations(page)).toEqual([]);
      await page.locator("[data-hfy-more]").click();
      await expect(items(page)).toHaveCount(3);
      await expect(page.locator("[data-hfy-more]")).toHaveCount(0);
      expect(s.calls.map((c) => c.query.cursor)).toEqual([undefined, "next"]);
    });

    test("switching tabs asks for the other state", async ({ page }) => {
      const s = await open(page, {});
      await page.locator('[data-hfy-tab="closed"]').click();
      await expect(items(page)).toHaveCount(2);
      expect(s.calls.at(-1).query.state).toBe("closed");
      await page.locator('[data-hfy-tab="open"]').click();
      await expect(items(page)).toHaveCount(3);
    });
  });
}

test("an empty queue says so", async ({ page }) => {
  await stub(page, {});
  await page.route(/\/api\/moderation\?/, (r) => r.fulfill({ json: { items: [], cursor: null } }));
  await page.goto("/me/moderation/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-hfy-empty]")).toHaveText("nothing is waiting. everything is visible.");
});

test("the settings hub shows 'moderation' for an admin with the flag on, and not for a member or with the flag off", async ({ page }) => {
  const SHELL = { shellV2: true, navMe: true };
  await stub(page, { flags: SHELL });
  await page.goto("/me/", { waitUntil: "domcontentloaded" });
  await expect(page.locator('.hfy-settings [data-hfy-setting="moderation"]')).toHaveAttribute("href", "/me/moderation/");
  const member = await page.context().newPage();
  await stub(member, { flags: SHELL, admin: false });
  await member.goto("/me/", { waitUntil: "domcontentloaded" });
  await expect(member.locator('.hfy-settings [data-hfy-setting="notifications"]')).toBeVisible();
  await expect(member.locator('.hfy-settings [data-hfy-setting="moderation"]')).toHaveCount(0);
  const off = await page.context().newPage();
  await stub(off, { flags: { ...SHELL, moderationV1: false } });
  await off.goto("/me/", { waitUntil: "domcontentloaded" });
  await expect(off.locator('.hfy-settings [data-hfy-setting="notifications"]')).toBeVisible();
  await expect(off.locator('.hfy-settings [data-hfy-setting="moderation"]')).toHaveCount(0);
});
