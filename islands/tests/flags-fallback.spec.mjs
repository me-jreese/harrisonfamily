// HFY-R58: preview-flag override safety. sessionStorage only, a visible "preview flags on — turn off" banner, automatic
// clear + fallback when a flagged dependency is unavailable (island 404, /auth/session unreachable), the authV2 sign-out, and the
// /family-login/ redirect page (HFY-TSK-317). All data is synthetic; /auth and /api are stubbed per test.
// The build flags (/_data/flags.json) are pinned to all-off here: production turned every flag on (12:40Z), and these tests
// exercise the preview override on top of a flags-off build, which is what the override exists for.
// Design-system pass: theme-color is a static head meta on every page (islands/heads.mjs block A, the surface token); only the
// manifest link is still added by the shell once it has mounted.
import { test, expect } from "@playwright/test";

const override = (page) => page.evaluate(() => ({ session: sessionStorage.getItem("hfy:flags"), local: localStorage.getItem("hfy:flags") }));
const banner = (page) => page.locator("[data-hfy-flag-banner][role=region]");

const THEME_COLOR = "#141210"; // --io-color-semantic-surface (archive-950)
const PAGES = ["/", "/about/", "/contact/", "/logged-out/", "/person/?id=I0001", "/privacy/", "/search/", "/terms/", "/posts/", "/me/", "/me/notifications/", "/offline.html"];

async function hermetic(page) {
  await page.route("https://accounts.google.com/**", (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: {} }));
}

test.beforeEach(async ({ page }) => { await hermetic(page); });

test("banner shows while an override is active; 'turn off' clears it and reloads without ?hfy_flags", async ({ page }) => {
  await page.goto("/about/?hfy_flags=shellV2");
  await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText("preview flags on —");
  await expect(banner(page).getByRole("button")).toHaveText("turn off");
  await expect(banner(page)).toHaveClass(/\bhfy-flag-banner\b/);
  expect(await page.locator("style[data-hfy-flag-banner]").count(), "styled by the theme layer, no injected <style>").toBe(0);
  const off = banner(page).getByRole("button", { name: "Turn off preview flags" });
  const box = await off.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // the shell leaves the banner in <body> (fixed overlay), it is not moved into the scroller
  expect(await page.evaluate(() => document.querySelector("[data-hfy-flag-banner][role=region]").parentElement === document.body)).toBe(true);
  await off.click();
  await page.waitForURL((u) => u.pathname === "/about/" && !u.searchParams.has("hfy_flags"));
  await expect(page.locator("nav.navbar-hf")).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  expect(await override(page)).toEqual({ session: null, local: null });
  expect(await page.locator("#hfy-shell-root").count()).toBe(0);
});

test("the override is per tab: a new tab in the same browser does not inherit it", async ({ page, context }) => {
  await page.goto("/about/?hfy_flags=shellV2");
  await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
  const other = await context.newPage();
  await hermetic(other);
  await other.goto("/about/");
  await other.waitForTimeout(500);
  await expect(other.locator("nav.navbar-hf")).toBeVisible();
  expect(await other.locator("#hfy-shell-root").count()).toBe(0);
  await expect(banner(other)).toHaveCount(0);
});

test("a pre-R58 localStorage override is purged and ignored", async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("hfy:flags", "authV2,searchV2,shellV2"); } });
  await page.goto("/about/");
  await page.waitForTimeout(600);
  expect(new URL(page.url()).pathname).toBe("/about/");
  expect(await override(page)).toEqual({ session: null, local: null });
  expect(await page.locator("#hfy-shell-root").count()).toBe(0);
  await expect(banner(page)).toHaveCount(0);
});

test("shell island 404: navbar restored, no manifest, static theme-color untouched, override auto-cleared", async ({ page }) => {
  await page.route("**/js/islands/shell.js*", (r) => r.fulfill({ status: 404, body: "not found" }));
  await page.goto("/about/?hfy_flags=shellV2");
  await expect.poll(() => override(page)).toEqual({ session: null, local: null });
  await expect(page.locator("nav.navbar-hf")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.classList.contains("hfy-shell-v2"))).toBe(false);
  expect(await page.locator('link[rel=manifest]').count()).toBe(0);
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", THEME_COLOR);
  await expect(banner(page)).toHaveCount(0);
  await page.goto("/about/");
  await page.waitForTimeout(400);
  expect(await page.locator("#hfy-shell-root").count()).toBe(0);
});

test("shell mounted: the manifest link appears only after the shell loads; theme-color is static throughout", async ({ page }) => {
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route("**/js/islands/shell.js*", async (r) => { await held; return r.continue(); });
  await page.goto("/about/?hfy_flags=shellV2", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  expect(await page.locator('link[rel=manifest]').count(), "no manifest before the shell").toBe(0);
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", THEME_COLOR);
  release();
  await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
  await expect(page.locator('link[rel=manifest]')).toHaveCount(1);
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", THEME_COLOR);
});

test("theme-color is static on every page (no JS needed) and nothing links the manifest without the shell", async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.route(/accounts\.google\.com/, (r) => r.abort());
  for (const path of PAGES) {
    await page.goto(path);
    const metas = await page.locator('meta[name="theme-color"]').evaluateAll((els) => els.map((e) => e.getAttribute("content")));
    expect(metas, path).toEqual([THEME_COLOR]);
    expect(await page.locator('link[rel=manifest]').count(), path).toBe(0);
  }
  await ctx.close();
});

test("searchV2 with the search island 404: nothing mounts (there is no legacy search page any more); override auto-cleared", async ({ page }) => {
  await page.route("**/js/islands/search.js*", (r) => r.fulfill({ status: 404, body: "not found" }));
  await page.goto("/search/?query=Quillfeather&hfy_flags=searchV2", { waitUntil: "domcontentloaded" });
  await expect.poll(() => override(page)).toEqual({ session: null, local: null });
  expect(await page.locator("#hfy-search-v2").count()).toBe(0);
  expect(await page.locator("[data-search-page], [data-search-results-list]").count()).toBe(0);
});

test.describe("desktop navbar", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("authV2 sign-out ends the edge session, purges what the retired Google sign-in left, and lands on /logged-out/", async ({ page }) => {
    let edgeSignedIn = true;
    const logouts = [];
    await page.route("**/auth/session", (r) => r.fulfill({ json: edgeSignedIn ? { authenticated: true, sub: "I0001", grampsId: "I0001", label: "Test" } : { authenticated: false } }));
    await page.route("**/auth/logout", (r) => { logouts.push(r.request().method()); edgeSignedIn = false; return r.fulfill({ status: 204, body: "" }); });
    await page.addInitScript(() => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("HFY_AUTH_ID_TOKEN", "retired-token");
      localStorage.setItem("HFY_AUTH_USER_GRAMPS_ID", "I0001");
      sessionStorage.setItem("HFY_GATEWAY_SESSION_V1", JSON.stringify({ token: "retired", expiresAt: Date.now() + 3600e3 }));
    });
    const edgeAnswered = page.waitForResponse("**/auth/session");
    await page.goto("/about/?hfy_flags=authV2");
    await edgeAnswered;
    await page.waitForTimeout(300);
    // the retired keys are purged on page load, before any sign-out
    expect(await page.evaluate(() => ({ t: localStorage.getItem("HFY_AUTH_ID_TOKEN"), g: localStorage.getItem("HFY_AUTH_USER_GRAMPS_ID"), s: sessionStorage.getItem("HFY_GATEWAY_SESSION_V1") }))).toEqual({ t: null, g: null, s: null });
    const out = page.locator("[data-auth-signout-link]");
    await expect(out).toBeVisible();
    await out.click();
    await page.waitForURL("**/logged-out/");
    await page.waitForTimeout(400);
    expect(logouts).toEqual(["POST"]);
    expect(await page.evaluate(() => localStorage.getItem("hfy:edge-session"))).toBeNull();
  });
});

test("authV2 with /auth/session unreachable: the page is left as it is and the override is cleared", async ({ page }) => {
  await page.route("**/auth/session", (r) => r.fulfill({ status: 404, contentType: "text/html", body: "<h1>Not Found</h1>" }));
  let loginHits = 0;
  await page.route("**/auth/login**", (r) => { loginHits += 1; return r.fulfill({ contentType: "text/html", body: "<h1>edge login</h1>" }); });
  await page.goto("/about/?hfy_flags=authV2");
  await expect.poll(() => override(page)).toEqual({ session: null, local: null });
  await page.waitForTimeout(400);
  expect(new URL(page.url()).pathname).toBe("/about/");
  expect(loginHits).toBe(0);
  await expect(banner(page)).toHaveCount(0);
});

test("authV2 with /auth/session network failure is treated as unreachable too", async ({ page }) => {
  await page.route("**/auth/session", (r) => r.abort());
  await page.goto("/about/?hfy_flags=authV2");
  await expect.poll(() => override(page)).toEqual({ session: null, local: null });
  expect(new URL(page.url()).pathname).toBe("/about/");
});

// HFY-TSK-317: /family-login/ is a static redirect page. It needs no flag, no feature-flags.js and no session probe.
async function loginStub(page) {
  const hits = [];
  await page.route("**/auth/login**", (r) => { hits.push(new URL(r.request().url())); return r.fulfill({ contentType: "text/html", body: "<h1>edge login</h1>" }); });
  return hits;
}

test("/family-login/ goes to /auth/login with returnTo=/, with no flag and no script file", async ({ page }) => {
  const hits = await loginStub(page);
  const scripts = [];
  page.on("request", (r) => { if (r.resourceType() === "script") scripts.push(r.url()); });
  await page.goto("/family-login/");
  await page.waitForURL((u) => u.pathname === "/auth/login" && u.searchParams.get("returnTo") === "/");
  expect(hits.length).toBe(1);
  expect(scripts).toEqual([]);
});

test("/family-login/ signed in at the edge still goes to /auth/login (the edge sign-in decides what a member sees)", async ({ page }) => {
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: "I0001", grampsId: "I0001", label: "Test" } }));
  const hits = await loginStub(page);
  await page.goto("/family-login/?hfy_flags=authV2");
  await page.waitForURL((u) => u.pathname === "/auth/login");
  expect(hits.length).toBe(1);
});

// HFY-TSK-069 (D-11 item 6): login continuity. /family-login/?next=<path> must reach /auth/login as returnTo, so the deep link
// that bounced the visitor (a person page, a search) is not lost after sign-in.
test("/family-login/?next= carries the deep link (path, query, hash) into returnTo", async ({ page }) => {
  await loginStub(page);
  const next = "/person/?id=I0113&tab=family#timeline";
  await page.goto("/family-login/?next=" + encodeURIComponent(next));
  await page.waitForURL((u) => u.pathname === "/auth/login");
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(next);
});

test("/family-login/: an unsafe next (other origin, protocol-relative, backslash, sign-in page) falls back to returnTo=/", async ({ page }) => {
  await loginStub(page);
  for (const next of ["https://evil.example/x", "//evil.example/x", "/\\evil.example", "/auth/link", "/family-login/"]) {
    await page.goto("/family-login/?next=" + encodeURIComponent(next));
    await page.waitForURL((u) => u.pathname === "/auth/login");
    expect(new URL(page.url()).searchParams.get("returnTo"), next).toBe("/");
    await page.goto("about:blank");
  }
});

for (const here of ["/person/?id=I0113", "/search/?query=Harrison"]) {
  test(`signed out under authV2 on ${here}: the sign-in link returns to the same page`, async ({ page }) => {
    await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: false } }));
    await page.goto(here + "&hfy_flags=authV2", { waitUntil: "domcontentloaded" });
    const link = page.locator('[data-feature="familyLoginLink"] a, a[data-feature="familyLoginLink"]').first();
    await expect.poll(async () => decodeURIComponent((await link.getAttribute("href")) || "")).toMatch(new RegExp("^/auth/login\\?returnTo=" + here.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
}

test("the retired Google sign-in's keys are purged on pages that do not load auth-v2.js (/posts/, /me/)", async ({ page }) => {
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: false } }));
  await page.addInitScript(() => {
    localStorage.setItem("HFY_AUTH_ID_TOKEN", "retired-token");
    localStorage.setItem("HFY_AUTH_USER_GRAMPS_ID", "I0001");
    sessionStorage.setItem("HFY_GATEWAY_SESSION_V1", JSON.stringify({ token: "retired" }));
  });
  for (const path of ["/posts/", "/me/"]) {
    await page.goto(path);
    expect(await page.locator("script[src*='auth-v2.js']").count(), `${path} does not load auth-v2.js`).toBe(0);
    expect(await page.evaluate(() => ({ t: localStorage.getItem("HFY_AUTH_ID_TOKEN"), g: localStorage.getItem("HFY_AUTH_USER_GRAMPS_ID"), s: sessionStorage.getItem("HFY_GATEWAY_SESSION_V1") }))).toEqual({ t: null, g: null, s: null });
  }
});

test("/search/ says search is unavailable when searchV2 is off or its island fails to load, instead of staying empty", async ({ page }) => {
  const note = page.locator("main [data-search-unavailable][role=status]");
  await page.goto("/search/");
  await expect(note).toHaveCount(1);
  await expect(note).toContainText("Search is not available");
  expect(await page.locator("#hfy-search-v2").count()).toBe(0);
  await page.route("**/js/islands/search.js*", (r) => r.fulfill({ status: 404, body: "" }));
  await page.goto("/search/?hfy_flags=searchV2");
  await expect(note).toHaveCount(1);
});
