// HFY-R58: preview-flag override safety. sessionStorage only, a visible "Preview flags on — turn off" banner, automatic
// clear + legacy fallback when a flagged dependency is unavailable (island 404, /auth/session unreachable), and an authV2
// sign-out that also runs the legacy signOut. All data is synthetic; /auth and /api are stubbed per test.
import { test, expect } from "@playwright/test";

const MANIFEST = { people: [
  { grampsId: "I0001", displayName: "Mary Quillfeather", isLiving: false, lifespanSummary: "1901 – 1980", primaryPhoto: null },
  { grampsId: "I0003", displayName: "Ada Brambleton", isLiving: false, lifespanSummary: "1850 – 1920", primaryPhoto: null }
] };
const INDEX = { documents: MANIFEST.people.map((p) => ({ grampsId: p.grampsId, searchText: p.displayName.toLowerCase() })) };

const override = (page) => page.evaluate(() => ({ session: sessionStorage.getItem("hfy:flags"), local: localStorage.getItem("hfy:flags") }));
const banner = (page) => page.locator("[data-hfy-flag-banner][role=region]");

async function hermetic(page) {
  await page.route("https://accounts.google.com/**", (r) => r.abort());
}

// Legacy gateway session (sessionStorage) so legacy search can load its data without a sign-in.
async function legacySearchSession(page) {
  await page.addInitScript(() => {
    try { sessionStorage.setItem("HFY_GATEWAY_SESSION_V1", JSON.stringify({ token: "test-token", grampsId: null, expiresAt: Date.now() + 3600e3, verifiedAt: Date.now() })); } catch {}
  });
  await page.route("**/person/index.json", (r) => r.fulfill({ json: MANIFEST }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: INDEX }));
}

test.beforeEach(async ({ page }) => { await hermetic(page); });

test("banner shows while an override is active; 'turn off' clears it and reloads without ?hfy_flags", async ({ page }) => {
  await page.goto("/about/?hfy_flags=shellV2");
  await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toContainText("Preview flags on");
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
  await page.goto("/family-login/");
  await page.waitForTimeout(600);
  expect(new URL(page.url()).pathname).toBe("/family-login/");
  expect(await override(page)).toEqual({ session: null, local: null });
  expect(await page.locator("#hfy-shell-root").count()).toBe(0);
  await expect(banner(page)).toHaveCount(0);
});

test("shell island 404: navbar restored, no manifest/theme-color, override auto-cleared", async ({ page }) => {
  await page.route("**/js/islands/shell.js", (r) => r.fulfill({ status: 404, body: "not found" }));
  await page.goto("/about/?hfy_flags=shellV2");
  await expect.poll(() => override(page)).toEqual({ session: null, local: null });
  await expect(page.locator("nav.navbar-hf")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.classList.contains("hfy-shell-v2"))).toBe(false);
  expect(await page.locator('link[rel=manifest]').count()).toBe(0);
  expect(await page.locator('meta[name="theme-color"]').count()).toBe(0);
  await expect(banner(page)).toHaveCount(0);
  await page.goto("/about/");
  await page.waitForTimeout(400);
  expect(await page.locator("#hfy-shell-root").count()).toBe(0);
});

test("shell mounted: manifest and theme-color are applied only after the shell loads", async ({ page }) => {
  await page.goto("/about/?hfy_flags=shellV2");
  await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
  await expect(page.locator('link[rel=manifest]')).toHaveCount(1);
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);
});

test("searchV2 with the search island 404: legacy /search/ page still searches; override auto-cleared", async ({ page }) => {
  await legacySearchSession(page);
  await page.route("**/js/islands/search.js", (r) => r.fulfill({ status: 404, body: "not found" }));
  await page.goto("/search/?query=Quillfeather&hfy_flags=searchV2", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-search-page]")).toBeVisible();
  await expect(page.locator("[data-search-results-list] .search-result-card").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-search-results-list] .search-result-card", { hasText: "Mary Quillfeather" })).toHaveCount(1);
  expect(await page.locator("#hfy-search-v2").count()).toBe(0);
  expect(await override(page)).toEqual({ session: null, local: null });
});

test.describe("desktop navbar", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("searchV2 with the shell island 404: legacy navbar search still suggests", async ({ page }) => {
    await legacySearchSession(page);
    await page.route("**/js/islands/shell.js", (r) => r.fulfill({ status: 404, body: "not found" }));
    await page.goto("/about/?hfy_flags=searchV2");
    await expect(page.locator("nav.navbar-hf")).toBeVisible();
    const input = page.locator("[data-search-form] [data-search-input]");
    await expect(input).toBeVisible();
    await input.fill("Quill");
    await expect(page.locator("[data-search-list] [data-search-option]", { hasText: "Mary Quillfeather" })).toBeVisible({ timeout: 10_000 });
  });

  test("searchV2 with -shellV2: no launcher anywhere, so the legacy navbar search stays live", async ({ page }) => {
    await legacySearchSession(page);
    await page.goto("/about/?hfy_flags=searchV2,-shellV2");
    const input = page.locator("[data-search-form] [data-search-input]");
    await expect(input).toBeVisible();
    await input.fill("Quill");
    await expect(page.locator("[data-search-list] [data-search-option]", { hasText: "Mary Quillfeather" })).toBeVisible({ timeout: 10_000 });
  });

  test("authV2 sign-out ends the edge session AND runs the legacy signOut", async ({ page }) => {
    let edgeSignedIn = true;
    const logouts = [];
    await page.route("**/auth/session", (r) => r.fulfill({ json: edgeSignedIn ? { authenticated: true, sub: "I0001", grampsId: "I0001", label: "Test" } : { authenticated: false } }));
    await page.route("**/auth/logout", (r) => { logouts.push(r.request().method()); edgeSignedIn = false; return r.fulfill({ status: 204, body: "" }); });
    await page.route("**/api/check-allowed", (r) => r.fulfill({ json: { allowed: true, sessionToken: "legacy-session-test", grampsId: "I0001", expiresIn: 3600 } }));
    await page.addInitScript(() => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, "");
      localStorage.setItem("HFY_AUTH_ID_TOKEN", `${b64({ alg: "none" })}.${b64({ email: "tester@example.test", sub: "test" })}.sig`);
      localStorage.setItem("HFY_AUTH_USER_GRAMPS_ID", "I0001");
    });
    const edgeAnswered = page.waitForResponse("**/auth/session");
    await page.goto("/about/?hfy_flags=authV2");
    // legacy restore minted the gateway session; the authV2 handler is wired once /auth/session answered
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("HFY_GATEWAY_SESSION_V1"))).not.toBeNull();
    await edgeAnswered;
    await page.waitForTimeout(300);
    const out = page.locator("[data-auth-signout-link]");
    await expect(out).toBeVisible();
    await out.click();
    await page.waitForURL("**/logged-out/");
    await page.waitForTimeout(400);
    expect(logouts).toEqual(["POST"]);
    expect(await page.evaluate(() => ({
      idToken: localStorage.getItem("HFY_AUTH_ID_TOKEN"),
      grampsId: localStorage.getItem("HFY_AUTH_USER_GRAMPS_ID"),
      gateway: sessionStorage.getItem("HFY_GATEWAY_SESSION_V1")
    }))).toEqual({ idToken: null, grampsId: null, gateway: null });
  });
});

test("authV2 with /auth/session unreachable: /family-login/ keeps the legacy flow and the override is cleared", async ({ page }) => {
  await page.route("**/auth/session", (r) => r.fulfill({ status: 404, contentType: "text/html", body: "<h1>Not Found</h1>" }));
  let loginHits = 0;
  await page.route("**/auth/login**", (r) => { loginHits += 1; return r.fulfill({ contentType: "text/html", body: "<h1>edge login</h1>" }); });
  await page.goto("/family-login/?hfy_flags=authV2");
  await expect.poll(() => override(page)).toEqual({ session: null, local: null });
  await page.waitForTimeout(400);
  expect(new URL(page.url()).pathname).toBe("/family-login/");
  expect(loginHits).toBe(0);
  await expect(banner(page)).toHaveCount(0);
});

test("authV2 with /auth/session network failure is treated as unreachable too", async ({ page }) => {
  await page.route("**/auth/session", (r) => r.abort());
  await page.goto("/family-login/?hfy_flags=authV2");
  await expect.poll(() => override(page)).toEqual({ session: null, local: null });
  expect(new URL(page.url()).pathname).toBe("/family-login/");
});

test("authV2 signed out at the edge: /family-login/ goes to /auth/login", async ({ page }) => {
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: false } }));
  await page.route("**/auth/login**", (r) => r.fulfill({ contentType: "text/html", body: "<h1>edge login</h1>" }));
  await page.goto("/family-login/?hfy_flags=authV2");
  await page.waitForURL((u) => u.pathname === "/auth/login" && u.searchParams.get("returnTo") === "/");
});

// HFY-TSK-069 (D-11 item 6): login continuity. /family-login/?next=<path> used to land on /auth/login?returnTo=%2F, so the deep link
// that bounced the visitor (a person page, a search) was lost after sign-in.
async function signedOutEdge(page) {
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: false } }));
  await page.route("**/auth/login**", (r) => r.fulfill({ contentType: "text/html", body: "<h1>edge login</h1>" }));
}

test("authV2 signed out: /family-login/?next= carries the deep link (path, query, hash) into returnTo", async ({ page }) => {
  await signedOutEdge(page);
  const next = "/person/?id=I0113&tab=family#timeline";
  await page.goto("/family-login/?next=" + encodeURIComponent(next) + "&hfy_flags=authV2");
  await page.waitForURL((u) => u.pathname === "/auth/login");
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(next);
});

test("authV2 signed out: an unsafe next (other origin, protocol-relative, backslash, sign-in page) falls back to returnTo=/", async ({ page }) => {
  await signedOutEdge(page);
  for (const next of ["https://evil.example/x", "//evil.example/x", "/\\evil.example", "/auth/link", "/family-login/"]) {
    await page.goto("/family-login/?next=" + encodeURIComponent(next) + "&hfy_flags=authV2");
    await page.waitForURL((u) => u.pathname === "/auth/login");
    expect(new URL(page.url()).searchParams.get("returnTo"), next).toBe("/");
    await page.goto("about:blank");
  }
});

for (const here of ["/person/?id=I0113#timeline", "/search/?query=Harrison"]) {
  test(`chain: the legacy 8 s token fallback on ${here} -> /family-login/?next= -> /auth/login keeps the original path`, async ({ page }) => {
    test.setTimeout(45_000);
    await signedOutEdge(page);
    await page.route("**/person/*.json", (r) => r.fulfill({ status: 401, json: { error: "unauthorized" } }));
    await page.goto(here); // authV2 off: person-page.js / search-results.js wait 8 s for a legacy X-HFY-Session token, then redirectToLogin()
    await page.waitForURL((u) => u.pathname === "/family-login/", { timeout: 20_000 });
    const bounced = new URL(page.url());
    expect(bounced.searchParams.get("next")).toBe(here);
    await page.goto(bounced.pathname + bounced.search + "&hfy_flags=authV2"); // the same visit with authV2 on (after the flip)
    await page.waitForURL((u) => u.pathname === "/auth/login");
    expect(new URL(page.url()).searchParams.get("returnTo")).toBe(here);
  });
}

test("authV2 already signed in at the edge: /family-login/ does not loop back to /auth/login", async ({ page }) => {
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: "I0001", grampsId: "I0001", label: "Test" } }));
  let loginHits = 0;
  await page.route("**/auth/login**", (r) => { loginHits += 1; return r.fulfill({ contentType: "text/html", body: "<h1>edge login</h1>" }); });
  await page.goto("/family-login/?hfy_flags=authV2");
  await page.waitForTimeout(800);
  expect(new URL(page.url()).pathname).toBe("/family-login/");
  expect(loginHits).toBe(0);
  await expect(banner(page)).toBeVisible();
});
