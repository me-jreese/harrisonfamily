// HFY-TSK-185 (flag inboxV1): the bell in the shell's bell slot, the bottom sheet (375) / anchored panel (768, 1280), the /me/inbox/ page,
// badge sync (bell + app icon), the settings hub row and the flag-off state. The inbox routes are the REAL api handler over the kit's
// in-memory inbox store (api/test/world.js), so the wire shape is the production one; /auth, /api/me and the flags file are stubbed.
// Synthetic people only. Run:  HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/inbox-ui.spec.mjs
import { test, expect } from "@playwright/test";
import { InMemoryNotificationStore } from "@io-kit/notify/server";
import { makeApi, signToken } from "../../api/test/world.js";
import { axeViolations } from "./axe.mjs";

const ME = "I0001";
const NAME = "Sam Example";
const FLAGS = { authV2: true, shellV2: true, navMe: true, inboxV1: true, notifyV2: true, searchV2: false, personV2: false, postsV2: false, aboutCta: false, photoTags: false, profileLinks: false };
const VIEWPORTS = [["375", { width: 375, height: 812 }], ["768", { width: 768, height: 1024 }], ["1280", { width: 1280, height: 800 }]];

/** Seed: three unread items (the first coalesces two events) and one read, newest last added = first listed. */
async function seed(inbox, { extra = 0 } = {}) {
  await inbox.add(ME, { type: "record_updated_followed", fields: { subject: "Pat Example" }, navigate: "/about/#followed" });
  const read = await inbox.add(ME, { type: "proposal_accepted", fields: { actor: NAME, subject: "Pat Example" }, navigate: "/about/#proposal" });
  await inbox.markRead(ME, [read.id]);
  for (let i = 0; i < extra; i += 1) await inbox.add(ME, { type: "mention", fields: { actor: `Visitor ${i}` }, navigate: `/about/#m${i}` });
  await inbox.add(ME, { type: "comment_on_my_record", fields: { actor: NAME }, navigate: "/about/#comment", group: "thread:person:I0001" });
  await inbox.add(ME, { type: "comment_on_my_record", fields: { actor: NAME }, navigate: "/about/#comment", group: "thread:person:I0001" });
  await inbox.add(ME, { type: "mention", fields: { actor: "Alex Example" }, navigate: "/about/#mention" });
}

async function wire(page, { flag = true, session = ME, extra = 0, admin = false, inboxStatus = 0, seeded = true } = {}) {
  const inbox = new InMemoryNotificationStore();
  const w = makeApi({ withPush: false, flags: { inboxV1: true }, inbox, admins: admin ? [ME] : ["I0099"] });
  if (seeded) await seed(inbox, { extra });
  const token = await signToken(ME);
  const log = { reads: [], inboxRequests: [], bundles: [], badge: [] };
  await page.addInitScript(() => {
    window.__badge = [];
    Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: (n) => { window.__badge.push(n); return Promise.resolve(); } });
    Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: () => { window.__badge.push(0); return Promise.resolve(); } });
  });
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { ...FLAGS, inboxV1: flag } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: session ? { authenticated: true, sub: session, grampsId: session, label: NAME } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route(/\/js\/islands\/(inbox|inbox-page)\./, (r) => { log.bundles.push(new URL(r.request().url()).pathname); return r.continue(); });
  await page.route("**/api/me", async (r) => {
    const res = await w.call("GET", "/api/me", { token });
    return r.fulfill({ status: res.status, json: res.body ?? {} });
  });
  await page.route("**/api/notifications/inbox**", async (r) => {
    const req = r.request();
    const u = new URL(req.url());
    log.inboxRequests.push(`${req.method()} ${u.pathname}${u.search}`);
    if (inboxStatus) return r.fulfill({ status: inboxStatus, json: { error: "server" } });
    const body = req.postData() ? JSON.parse(req.postData()) : undefined;
    if (req.method() === "POST") log.reads.push(body);
    const res = await w.call(req.method(), u.pathname, { token, body, query: Object.fromEntries(u.searchParams) });
    return r.fulfill({ status: res.status, json: res.body ?? {} });
  });
  await page.route("**/api/**", (r) => (/\/api\/(me|notifications\/inbox)/.test(r.request().url()) ? r.fallback() : r.fulfill({ json: {} })));
  return { inbox, w, log };
}

const bellBtn = (page) => page.locator('.hfy-bar__end [data-slot="bell"] button.iok-notify-bell');
const unreadOf = (inbox) => inbox.unreadCount(ME);
const appBadge = (page) => page.evaluate(() => window.__badge.at(-1));
/** The kit sheet rises with an opacity animation; axe must not read its colours mid-fade. */
const calm = (page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });
    const compact = name === "375";

    test("the bell fills the bell slot (before the gear and the account), a 44px target with the unread count, axe clean", async ({ page }) => {
      const { inbox } = await wire(page);
      await page.goto("/contact/", { waitUntil: "domcontentloaded" });
      const bell = bellBtn(page);
      await expect(bell).toBeVisible();
      await expect(bell).toHaveAccessibleName("notifications, 3 unread");
      await expect(bell).toHaveAttribute("aria-expanded", "false");
      await expect(bell.locator(".iok-notify-bell-badge")).toHaveText("3");
      const box = await bell.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(43.5);
      expect(box.height).toBeGreaterThanOrEqual(43.5);
      // the four ordered slots: bell, (chat is nobody's yet), gear, account
      const order = await page.locator(".hfy-bar__end > [data-slot]").evaluateAll((els) => els.map((e) => e.getAttribute("data-slot")));
      expect(order).toEqual(["bell", "gear", "account"]);
      expect(await unreadOf(inbox)).toBe(3);
      expect(await noHScroll(page)).toBe(true);
      expect(await axeViolations(page)).toEqual([]);
    });

    test(`${compact ? "a bottom sheet" : "an anchored panel"} opens; Escape closes it and focus returns to the bell; so does an outside click; opening marks nothing read`, async ({ page }) => {
      const { inbox, log } = await wire(page);
      await page.goto("/contact/", { waitUntil: "domcontentloaded" });
      const bell = bellBtn(page);
      await expect(bell).toBeVisible();
      await bell.click();
      await expect(bell).toHaveAttribute("aria-expanded", "true");
      const surface = compact ? page.locator('.io-sheet[data-side="bottom"].hfy-inbox-sheet') : page.locator(".hfy-inbox-panel");
      await expect(surface).toBeVisible();
      await expect(page.locator(compact ? ".hfy-inbox-panel" : ".io-sheet.hfy-inbox-sheet")).toHaveCount(0);
      const dialog = compact ? surface.getByRole("dialog") : surface;
      await expect(dialog).toHaveAttribute("role", "dialog");
      if (compact) await expect(surface.locator(".io-sheet__title")).toHaveText("notifications");
      // rows: newest first, the coalesced comment says ×2, the read one has no "mark read" button
      const rows = surface.locator(".iok-notify-inbox-item");
      await expect(rows).toHaveCount(4);
      await expect(rows.nth(0).locator(".iok-notify-inbox-count")).toHaveCount(0); // the mention
      await expect(rows.nth(1).locator(".iok-notify-inbox-count")).toHaveText("×2");
      await expect(rows.filter({ has: page.locator(".iok-notify-inbox-mark") })).toHaveCount(3);
      for (const row of await rows.all()) expect((await row.boundingBox()).height).toBeGreaterThanOrEqual(compact ? 55.5 : 43.5);
      await expect(surface.getByRole("link", { name: "see all" })).toHaveAttribute("href", "/me/inbox/");
      await expect(surface.getByRole("link", { name: "notification settings" })).toHaveAttribute("href", "/me/notifications/");
      // nothing was marked read by opening
      expect(log.reads).toEqual([]);
      expect(await unreadOf(inbox)).toBe(3);
      if (!compact) {
        const b = await bell.boundingBox();
        const p = await dialog.boundingBox();
        expect(p.y).toBeGreaterThanOrEqual(b.y + b.height - 1);
        expect(Math.abs(p.x + p.width - (b.x + b.width))).toBeLessThanOrEqual(2); // right-aligned under the bell
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.width).toBeLessThanOrEqual(440.5);
        expect(p.y + p.height).toBeLessThanOrEqual(viewport.height);
      } else {
        const p = await surface.locator(".io-sheet__panel").boundingBox();
        expect(p.width).toBeGreaterThanOrEqual(viewport.width - 1);
        expect(p.height).toBeLessThanOrEqual(viewport.height * 0.85 + 1);
      }
      expect(await noHScroll(page)).toBe(true);
      await calm(page);
      expect(await axeViolations(page)).toEqual([]);

      await page.keyboard.press("Escape");
      await expect(surface).toHaveCount(0);
      await expect(bell).toHaveAttribute("aria-expanded", "false");
      await expect(bell).toBeFocused();

      await bell.click();
      await expect(surface).toBeVisible();
      // an outside click: on the page area (a sheet's scrim, a panel's page) closes it and returns focus to the bell
      await page.mouse.click(compact ? 190 : 40, compact ? 40 : 700);
      await expect(surface).toHaveCount(0);
      await expect(bell).toBeFocused();
      expect(log.reads).toEqual([]);
    });

    test("tapping an item marks it read and navigates; the bell badge and the app badge follow", async ({ page }) => {
      const { inbox, log } = await wire(page);
      await page.goto("/contact/", { waitUntil: "domcontentloaded" });
      const bell = bellBtn(page);
      await expect(bell).toHaveAccessibleName("notifications, 3 unread");
      await expect.poll(() => appBadge(page)).toBe(3);
      await bell.click();
      const surface = compact ? page.locator(".io-sheet.hfy-inbox-sheet") : page.locator(".hfy-inbox-panel");
      await surface.getByRole("link", { name: /Alex Example mentioned you/ }).click();
      await page.waitForURL(/\/about\/#mention$/);
      expect(log.reads).toHaveLength(1);
      expect(log.reads[0].ids).toHaveLength(1);
      await expect.poll(() => unreadOf(inbox)).toBe(2);
      // the unread badge on the next page agrees: the item the tap marked is read on the server
      await expect(bellBtn(page)).toHaveAccessibleName("notifications, 2 unread");
    });

    test("'mark read' and 'mark all read' update the bell badge and the app badge (setAppBadge asserted)", async ({ page }) => {
      const { inbox, log } = await wire(page);
      await page.goto("/contact/", { waitUntil: "domcontentloaded" });
      const bell = bellBtn(page);
      await expect.poll(() => appBadge(page)).toBe(3);
      await bell.click();
      const surface = compact ? page.locator(".io-sheet.hfy-inbox-sheet") : page.locator(".hfy-inbox-panel");
      await surface.locator(".iok-notify-inbox-mark").first().click();
      await expect(bell).toHaveAccessibleName("notifications, 2 unread");
      await expect(bell.locator(".iok-notify-bell-badge")).toHaveText("2");
      await expect.poll(() => appBadge(page)).toBe(2);
      await expect.poll(() => unreadOf(inbox)).toBe(2);
      expect(log.reads.at(-1)).toHaveProperty("ids");
      await surface.getByRole("button", { name: "mark all read" }).click();
      await expect(bell).toHaveAccessibleName("notifications");
      await expect(bell.locator(".iok-notify-bell-badge")).toHaveCount(0);
      await expect.poll(() => appBadge(page)).toBe(0); // clearAppBadge for 0
      await expect.poll(() => unreadOf(inbox)).toBe(0);
      expect(log.reads.at(-1)).toMatchObject({ all: true });
      await expect(surface.locator(".iok-notify-inbox-item[data-unread]")).toHaveCount(0);
      await calm(page);
      expect(await axeViolations(page)).toEqual([]);
    });
  });
}

test("375: the unread/all filter, 'show older' and the select mode are 44px targets that fit the sheet", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { log } = await wire(page, { extra: 30 });
  await page.goto("/contact/", { waitUntil: "domcontentloaded" });
  await bellBtn(page).click();
  const sheet = page.locator(".io-sheet.hfy-inbox-sheet");
  await expect(sheet.locator(".iok-notify-inbox-item")).toHaveCount(20);
  const small = await sheet.evaluate((root) => [...root.querySelectorAll("button, a[href], input")].filter((e) => { const r = e.getBoundingClientRect(); return (r.width || r.height) && (r.width < 43.5 || r.height < 43.5); }).map((e) => `${e.tagName} ${e.className}`));
  expect(small).toEqual([]);
  await sheet.getByRole("button", { name: "show older" }).click();
  await expect(sheet.locator(".iok-notify-inbox-item")).toHaveCount(34);
  await sheet.getByRole("button", { name: "unread", exact: true }).click();
  await expect.poll(() => log.inboxRequests.some((r) => /filter=unread/.test(r))).toBe(true);
  await expect(sheet.locator(".iok-notify-inbox-item:not([data-unread])")).toHaveCount(0);
  expect(await noHScroll(page)).toBe(true);
  await calm(page);
  expect(await axeViolations(page)).toEqual([]);
});

test("the load-failed state says so and offers a retry; the empty state says you're caught up (axe clean)", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await wire(page, { inboxStatus: 500 });
  await page.goto("/contact/", { waitUntil: "domcontentloaded" });
  await bellBtn(page).click();
  const sheet = page.locator(".io-sheet.hfy-inbox-sheet");
  await expect(sheet.getByRole("alert")).toContainText("that didn't work. try again, or text J.");
  await expect(sheet.getByRole("button", { name: "try again" })).toBeVisible();
  await calm(page);
  expect(await axeViolations(page)).toEqual([]);
});

test("empty inbox: you're all caught up", async ({ page }) => {
  await wire(page, { seeded: false });
  await page.goto("/contact/", { waitUntil: "domcontentloaded" });
  await bellBtn(page).click();
  await expect(page.locator(".hfy-inbox-panel, .io-sheet.hfy-inbox-sheet")).toContainText("you're all caught up.");
  await calm(page);
  expect(await axeViolations(page)).toEqual([]);
});

test("signed out with the flag on: no bell, and the bell bundle is never requested", async ({ page }) => {
  const { log } = await wire(page, { session: null });
  await page.goto("/contact/", { waitUntil: "domcontentloaded" });
  await expect(page.locator('#hfy-shell-root a[data-hfy-account="signed-out"]')).toBeVisible();
  await expect(page.locator('.hfy-bar__end [data-slot="bell"]')).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(log.bundles).toEqual([]);
  expect(log.inboxRequests).toEqual([]);
});

test("flag off: no bell, no inbox request, and /me/inbox/ is the neutral 'not available yet' page with no feature bundle", async ({ page }) => {
  const { log } = await wire(page, { flag: false });
  await page.goto("/contact/", { waitUntil: "domcontentloaded" });
  await expect(page.locator('.hfy-bar__end [data-slot="account"]')).toBeVisible();
  await expect(page.locator('.hfy-bar__end [data-slot="bell"]')).toHaveCount(0);
  await page.goto("/me/inbox/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "your inbox" })).toBeVisible();
  await expect(page.locator("[data-inbox-off]")).toHaveText("your inbox isn't available yet.");
  await expect(page.locator(".iok-notify-inbox, .hfy-inboxpage")).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(log.bundles).toEqual([]);
  expect(log.inboxRequests).toEqual([]);
  expect(await axeViolations(page)).toEqual([]);
});

test("the build flags file ships inboxV1 false; ?hfy_flags=inboxV1 turns the bell on for the tab (no flags stub)", async ({ page }) => {
  const flagsFile = await (await page.request.get("/_data/flags.json")).json();
  expect(flagsFile.inboxV1).toBe(false);
  await wire(page);
  await page.unroute("**/_data/flags.json"); // the real file, not the stub
  await page.goto("/contact/", { waitUntil: "domcontentloaded" });
  await expect(page.locator('.hfy-bar__end [data-slot="account"]')).toBeVisible();
  await expect(page.locator('.hfy-bar__end [data-slot="bell"]')).toHaveCount(0);
  await page.goto("/contact/?hfy_flags=inboxV1", { waitUntil: "domcontentloaded" });
  await expect(bellBtn(page)).toBeVisible();
});

for (const [name, viewport] of [VIEWPORTS[0], VIEWPORTS[2]]) {
  test.describe(`/me/inbox/ at ${name}px`, () => {
    test.use({ viewport });

    test("the page renders the inbox, with the settings link; mark all read clears both badges; axe clean, no horizontal scroll", async ({ page }) => {
      const { inbox, log } = await wire(page, { extra: 25 });
      await page.goto("/me/inbox/", { waitUntil: "domcontentloaded" });
      await expect(page.locator("[data-inbox-off]")).toHaveCount(0);
      const main = page.locator(".hfy-inboxpage");
      await expect(page.getByRole("heading", { level: 1, name: "your inbox" })).toBeVisible();
      await expect(main.getByRole("heading", { level: 2, name: "notifications" })).toBeVisible();
      await expect(main.locator(".iok-notify-inbox-item")).toHaveCount(20);
      await expect(main.getByRole("link", { name: "notification settings" })).toHaveAttribute("href", "/me/notifications/");
      // the bell is on this page too, and agrees with the page
      const bell = bellBtn(page);
      await expect(bell).toHaveAccessibleName("notifications, 28 unread");
      await expect(bell.locator(".iok-notify-bell-badge")).toHaveText("9+");
      expect(await noHScroll(page)).toBe(true);
      expect(await axeViolations(page)).toEqual([]);
      await main.getByRole("button", { name: "mark all read" }).click();
      await expect.poll(() => unreadOf(inbox)).toBe(0);
      await expect.poll(() => appBadge(page)).toBe(0);
      // the bell (a second useInbox in this tab) hears of it through the BroadcastChannel
      await expect(bell).toHaveAccessibleName("notifications");
      expect(log.reads.at(-1)).toMatchObject({ all: true });
      expect(await axeViolations(page)).toEqual([]);
    });

    test("signed out: the neutral sign-in line, no inbox request", async ({ page }) => {
      const { log } = await wire(page, { session: null });
      await page.goto("/me/inbox/", { waitUntil: "domcontentloaded" });
      const gate = page.locator(".hfy-inboxpage [data-hfy-gate]");
      await expect(gate.locator("p")).toHaveText("this page is family-only. sign in to see it.");
      await expect(gate.getByRole("link", { name: "sign in" })).toHaveAttribute("href", "/auth/login?returnTo=%2Fme%2Finbox%2F");
      expect(log.inboxRequests).toEqual([]);
      expect(await axeViolations(page)).toEqual([]);
    });
  });
}

test("the settings hub gains an inbox row (inboxV1 only), after notifications", async ({ page }) => {
  await wire(page);
  await page.goto("/me/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".hfy-settings [data-hfy-setting]")).toHaveCount(4);
  const ids = await page.locator(".hfy-settings [data-hfy-setting]").evaluateAll((els) => els.map((e) => e.getAttribute("data-hfy-setting")));
  expect(ids).toEqual(["notifications", "inbox", "sign-in", "sign-out"]);
  await expect(page.locator('.hfy-settings [data-hfy-setting="inbox"]')).toHaveAttribute("href", "/me/inbox/");
  expect(await axeViolations(page)).toEqual([]);
  await page.unroute("**/_data/flags.json");
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { ...FLAGS, inboxV1: false } }));
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".hfy-settings [data-hfy-setting]")).toHaveCount(3);
  await expect(page.locator('.hfy-settings [data-hfy-setting="inbox"]')).toHaveCount(0);
});

test("/me/notifications/: an admin sees the 'for moderators' group, a member does not", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await wire(page, { admin: true });
  await page.route("**/api/notifications/preferences", (r) => r.fulfill({ json: { enabled: true, types: {}, extra: {} } }));
  await page.route("**/api/notifications/vapid-public-key", (r) => r.fulfill({ json: { public_key: "AAAA" } }));
  await page.goto("/me/notifications/", { waitUntil: "domcontentloaded" });
  const root = page.locator(".hfy-notify");
  await expect(root.getByRole("heading", { name: "for moderators" })).toBeVisible();
  await expect(root.locator('[data-type="proposal_submitted"]')).toBeVisible();
  await expect(root.getByRole("heading", { name: "about me" })).toBeVisible();
});
