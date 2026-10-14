// HFY-TSK-186 (flag recordSubsV1): the follow toggle on the person hero and "pages you follow" on /me/notifications/, at 375 and 1280.
// Synthetic people only; /auth, /api, the flags file and the person JSON are stubbed. The subscriptions API is held in memory.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/follow-ui.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]];
const NAMES = Array.from({ length: 13 }, (_, i) => ({ grampsId: `I90${String(20 + i)}`, displayName: `Followed Person ${i + 1} (synthetic)` }));

/** /api/subscriptions in memory. `failWrites` makes PUT and DELETE answer 500; `routes: false` answers 404 (flag off at the API). */
async function stub(page, { flag = true, session = "I9002", following = [], failWrites = false, routes = true } = {}) {
  const state = { following: [...following], puts: [], dels: [], gets: [], bundleRequests: [], meCalls: 0, delStatus: 0, failWrites };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: true, navMe: false, aboutCta: false, photoTags: false, profileLinks: false, recordSubsV1: flag } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: session ? { authenticated: true, sub: session, grampsId: session, label: "Sam Example" } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: NAMES } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route("**/person/I9001.json", (r) => r.fulfill({ json: PERSON }));
  await page.route("**/media/tree_I9001.svg", (r) => r.fulfill({ contentType: "image/svg+xml", body: readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8") }));
  await page.route(/\/media\/MPHOTO\d\.jpg/, (r) => r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="gray"/></svg>' }));
  await page.route(/\/js\/islands\/follow\./, (r) => { state.bundleRequests.push(r.request().url()); return r.continue(); });
  await page.route("**/api/me", (r) => { state.meCalls++; return r.fulfill({ json: session ? { id: session, label: "Sam Example", admin: false, can: {} } : { error: "unauthenticated" }, status: session ? 200 : 401 }); });
  await page.route("**/api/comments**", (r) => r.fulfill({ json: { thread: { id: "person:I9001", topic: "comments", comments: [], reactions: {} } } }));
  await page.route("**/api/notifications/**", (r) => {
    const u = new URL(r.request().url());
    if (u.pathname.endsWith("/vapid-public-key")) return r.fulfill({ json: { public_key: "AAAA" } });
    return r.fulfill({ json: { enabled: true, types: {} } });
  });
  await page.route("**/api/subscriptions**", async (r) => {
    const req = r.request();
    const u = new URL(req.url());
    if (!routes) return r.fulfill({ status: 404, json: { error: "not_found" } });
    const m = /\/subscriptions\/person\/([^/]+)$/.exec(u.pathname);
    if (m) {
      if (state.failWrites) return r.fulfill({ status: 500, json: { error: "server", message: "x" } });
      if (req.method() === "PUT") { state.puts.push({ id: m[1], body: req.postDataJSON() }); if (!state.following.includes(m[1])) state.following.unshift(m[1]); return r.fulfill({ json: { subject: `person:${m[1]}`, subscribed: true } }); }
      state.dels.push(m[1]);
      if (state.delStatus) return r.fulfill({ status: state.delStatus, json: { error: "not_found" } });
      state.following = state.following.filter((x) => x !== m[1]);
      return r.fulfill({ status: 204, body: "" });
    }
    state.gets.push(u.search);
    const subject = u.searchParams.get("subject");
    if (subject) return r.fulfill({ json: { subject, subscribed: state.following.includes(subject.replace("person:", "")) } });
    const limit = Number(u.searchParams.get("limit") || 25);
    const start = Number(u.searchParams.get("cursor") || 0);
    const slice = state.following.slice(start, start + limit);
    return r.fulfill({ json: { items: slice.map((id) => ({ subject: `person:${id}`, created_at: "2026-01-01T00:00:00Z" })), cursor: start + limit < state.following.length ? String(start + limit) : null } });
  });
  return state;
}

const openPerson = async (page, opts) => {
  const state = await stub(page, opts);
  await page.goto("/person/?id=I9001", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-hero h1")).toHaveText("Test Person (synthetic)");
  return state;
};
const toggle = (page) => page.locator('#person-hero [data-slot="follow"] button[aria-pressed]');

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("person hero: a 44px follow toggle with aria-pressed, layout per width, axe clean", async ({ page }) => {
      await openPerson(page);
      const btn = toggle(page);
      await expect(btn).toHaveText("follow");
      await expect(btn).toHaveAttribute("aria-pressed", "false");
      const box = await btn.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(43.5);
      const h1 = await page.locator("#person-hero h1").boundingBox();
      if (name === "375") {
        expect(box.y, "below the name").toBeGreaterThanOrEqual(h1.y + h1.height - 1);
        const heading = await page.locator("#person-hero .person-heading").boundingBox();
        expect(box.width, "full width").toBeGreaterThanOrEqual(heading.width - 2);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      } else {
        expect(box.y, "inline with the name").toBeLessThan(h1.y + h1.height);
        expect(box.x, "to the right of the name's start").toBeGreaterThan(h1.x);
      }
      expect(await axeViolations(page)).toEqual([]);
    });

    test("person hero: follow and unfollow call the API, the helper shows once", async ({ page }) => {
      const state = await openPerson(page);
      await toggle(page).click();
      await expect(toggle(page)).toHaveText("following");
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("[data-hfy-follow-helper]")).toHaveText("we'll let you know when this page changes.");
      expect(state.puts).toEqual([{ id: "I9001", body: {} }]);
      await toggle(page).click();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
      await expect(page.locator("[data-hfy-follow-helper]")).toHaveCount(0);
      expect(state.dels).toEqual(["I9001"]);
      await toggle(page).click();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("[data-hfy-follow-helper]"), "not the second time").toHaveCount(0);
    });

    test("person hero: already following shows 'following'", async ({ page }) => {
      await openPerson(page, { following: ["I9001"] });
      await expect(toggle(page)).toHaveText("following");
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
    });

    test("person hero: a failed call rolls the toggle back and shows a banner", async ({ page }) => {
      const state = await openPerson(page, { failWrites: true });
      await toggle(page).click();
      await expect(page.locator("[data-hfy-banner]")).toHaveText("that didn't save. try again, or text J.");
      await expect(toggle(page)).toHaveText("follow");
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
      expect(state.puts).toEqual([]);
      expect(await axeViolations(page)).toEqual([]);
      state.failWrites = false;
      await toggle(page).click();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("[data-hfy-banner]")).toHaveCount(0);
    });

    test("person hero: the toggle survives a hero rebuild without asking again", async ({ page }) => {
      const state = await openPerson(page);
      await toggle(page).click();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
      const gets = state.gets.length;
      await page.evaluate(() => document.dispatchEvent(new CustomEvent("hfy:person-rendered", { detail: { personId: "I9001" } })));
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
      expect(state.gets.length).toBe(gets);
    });

    test("person hero: hidden on your own page", async ({ page }) => {
      // own page: the viewer is the person
      const own = await openPerson(page, { session: "I9001" });
      await expect.poll(() => own.meCalls).toBeGreaterThan(0);
      await page.waitForLoadState("networkidle");
      expect(own.gets).toEqual([]);
      await expect(page.locator('#person-hero [data-slot="follow"]')).toBeEmpty();
      await expect(page.locator(".person-heading[data-hfy-follow-row]")).toHaveCount(0);
    });

    test("person hero: hidden when signed out", async ({ page }) => {
      const s = await openPerson(page, { session: null });
      await expect.poll(() => s.bundleRequests.length).toBeGreaterThan(0);
      await page.waitForLoadState("networkidle");
      await expect(page.locator('#person-hero [data-slot="follow"]')).toBeEmpty();
      expect(s.gets).toEqual([]);
    });

    test("person hero: a rebuild for a different person asks again; a merged id that is your own page hides it", async ({ page }) => {
      const state = await openPerson(page);
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
      const gets = state.gets.length;
      await page.evaluate(() => document.dispatchEvent(new CustomEvent("hfy:person-rendered", { detail: { personId: "I9003" } })));
      await expect.poll(() => state.gets.length).toBeGreaterThan(gets);
      expect(state.gets.at(-1)).toContain("person%3AI9003");
      await toggle(page).click();
      await expect.poll(() => state.puts.map((p) => p.id)).toEqual(["I9003"]);
      await page.evaluate(() => document.dispatchEvent(new CustomEvent("hfy:person-rendered", { detail: { personId: "I9002" } })));
      await expect(page.locator('#person-hero [data-slot="follow"]')).toBeEmpty();
    });

    test("person hero: quick double click sends one request", async ({ page }) => {
      const state = await openPerson(page);
      await toggle(page).dblclick();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
      expect(state.puts.length + state.dels.length).toBe(1);
    });

    test("person hero: the button keeps one accessible name and the helper is a status", async ({ page }) => {
      await openPerson(page);
      await expect(toggle(page)).toHaveAttribute("aria-label", "follow this page");
      await toggle(page).click();
      await expect(page.locator("[data-hfy-follow-helper]")).toHaveAttribute("role", "status");
    });

    test("person hero: flag off requests no bundle", async ({ page }) => {
      const off = await openPerson(page, { flag: false });
      await page.waitForTimeout(400);
      expect(off.bundleRequests).toEqual([]);
      await expect(page.locator('#person-hero [data-slot="follow"]')).toBeEmpty();
    });

    test("person hero: routes dark (404) shows nothing", async ({ page }) => {
      const dark = await openPerson(page, { routes: false });
      await expect.poll(() => dark.bundleRequests.length).toBeGreaterThan(0);
      await page.waitForTimeout(300);
      await expect(page.locator('#person-hero [data-slot="follow"]')).toBeEmpty();
    });

    test("settings: pages you follow lists names as links with unfollow and show more, axe clean, 44px targets", async ({ page }) => {
      const ids = NAMES.map((n) => n.grampsId);
      const state = await stub(page, { following: ids });
      await page.goto("/me/notifications/", { waitUntil: "domcontentloaded" });
      const section = page.locator("[data-hfy-followed]");
      await expect(section.getByRole("heading", { name: "pages you follow", level: 2 })).toBeVisible();
      const rows = section.locator("li");
      await expect(rows).toHaveCount(10);
      const first = rows.first();
      await expect(first.getByRole("link", { name: "Followed Person 1 (synthetic)" })).toHaveAttribute("href", "/person/?id=I9020");
      await expect(first.getByRole("button", { name: "unfollow Followed Person 1 (synthetic)" })).toHaveText("unfollow");
      for (const b of await section.getByRole("button").all()) expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(43.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await axeViolations(page)).toEqual([]);
      await section.getByRole("button", { name: "show more" }).click();
      await expect(rows).toHaveCount(13);
      await expect(section.getByRole("button", { name: "show more" })).toHaveCount(0);
      await rows.first().getByRole("button", { name: /^unfollow/ }).click();
      await expect(rows).toHaveCount(12);
      expect(state.dels).toEqual(["I9020"]);
      expect(await axeViolations(page)).toEqual([]);
    });

    test("settings: unfollow of a page already gone drops the row without a banner", async ({ page }) => {
      const state = await stub(page, { following: ["I9020", "I9021"] });
      state.delStatus = 404;
      await page.goto("/me/notifications/", { waitUntil: "domcontentloaded" });
      const rows = page.locator("[data-hfy-followed] li");
      await expect(rows).toHaveCount(2);
      await rows.first().getByRole("button", { name: /^unfollow/ }).click();
      await expect(rows).toHaveCount(1);
      await expect(page.locator("[data-hfy-followed] [data-hfy-banner]")).toHaveCount(0);
    });

    test("settings: an empty list says so; flag off or routes dark shows no section", async ({ page }) => {
      await stub(page, { following: [] });
      await page.goto("/me/notifications/", { waitUntil: "domcontentloaded" });
      await expect(page.locator("[data-hfy-followed] .hfy-followed__empty")).toHaveText("you're not following any pages yet. open someone's page and tap follow.");
      await page.unrouteAll();
      await stub(page, { flag: false, following: ["I9020"] });
      await page.goto("/me/notifications/", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".hfy-notify")).toBeVisible();
      await page.waitForTimeout(300);
      await expect(page.locator("[data-hfy-followed]")).toHaveCount(0);
      await page.unrouteAll();
      await stub(page, { routes: false });
      await page.goto("/me/notifications/", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".hfy-notify")).toBeVisible();
      await page.waitForTimeout(300);
      await expect(page.locator("[data-hfy-followed]")).toHaveCount(0);
    });
  });
}

test("the build flags file ships recordSubsV1 false", async ({ page }) => {
  const flags = JSON.parse(readFileSync(new URL("../../11ty/_data/flags.json", import.meta.url), "utf8"));
  expect(flags.recordSubsV1).toBe(false);
  void page;
});
