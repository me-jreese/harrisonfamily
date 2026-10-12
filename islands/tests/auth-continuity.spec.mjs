// HFY-R66: authV2 session continuity against the real static pages. /auth/*, /api and the gated data paths are stubbed by
// route interception; data is synthetic. The gate is modelled as "401 until /auth/refresh has answered 200" (io_id lapsed,
// io_rt still valid), which is what a member sees an hour after signing in.
// The build flags (/_data/flags.json) are pinned to all-off here, as in flags-fallback.spec.mjs: production turned every flag on
// (HFY-TSK-069, 12:40Z), and each test names the flags it exercises with ?hfy_flags= on top of a flags-off build ("flag off
// (parity)" relies on authV2 being off; the desktop-navbar tests need the legacy navbar, which shellV2 replaces).
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-synthetic.json", import.meta.url), "utf8"));
const MANIFEST = { people: [
  { grampsId: "I0001", displayName: "Mary Quillfeather", isLiving: false, lifespanSummary: "1901 – 1980", primaryPhoto: null },
  { grampsId: "I0003", displayName: "Ada Brambleton", isLiving: false, lifespanSummary: "1850 – 1920", primaryPhoto: null }
] };
const INDEX = { documents: MANIFEST.people.map((p) => ({ grampsId: p.grampsId, searchText: p.displayName.toLowerCase() })) };
const PERSON_PATH = "/person/?id=I9001&hfy_flags=authV2";

/**
 * session(n)  -> /auth/session body for the n-th call
 * refresh     -> status /auth/refresh answers (200 re-sets io_id, 401 = refresh token gone)
 * gate        -> "lapsed" (401 until a refresh succeeded), "open" (200) or "closed" (always 401)
 */
async function edge(page, { session = () => ({ authenticated: true, sub: "I9001", grampsId: "I9001", label: "Test" }), refresh = 200, gate = "open", legacyToken = false, seen = false } = {}) {
  const log = { session: 0, refresh: [], login: 0, data: [] };
  let refreshed = false;
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: {} }));
  await page.route("**/api/**", (r) => r.fulfill({ status: 403, json: { allowed: false } }));
  await page.route("**/auth/session", (r) => { log.session += 1; return r.fulfill({ json: session(log.session) }); });
  await page.route("**/auth/refresh", (r) => {
    const req = r.request();
    log.refresh.push({ method: req.method(), xrw: req.headers()["x-requested-with"] || null });
    if (refresh === 200) { refreshed = true; return r.fulfill({ json: { exp: Math.floor(Date.now() / 1000) + 3600 } }); }
    return r.fulfill({ status: refresh, json: { code: "AUTH_REFRESH_FAILED" } });
  });
  await page.route("**/auth/login**", (r) => { log.login += 1; return r.fulfill({ contentType: "text/html", body: "<h1>edge login</h1>" }); });
  const gated = (body) => (r) => {
    log.data.push({ url: new URL(r.request().url()).pathname, session: r.request().headers()["x-hfy-session"] || null });
    const allow = gate === "open" || (gate === "lapsed" && refreshed);
    return allow ? r.fulfill({ json: body }) : r.fulfill({ status: 401, json: { error: "unauthorized" } });
  };
  await page.route("**/person/I9001.json", gated(PERSON));
  await page.route("**/person/index.json", gated(MANIFEST));
  await page.route("**/person/search-index.json", gated(INDEX));
  await page.addInitScript(({ legacyToken, seen }) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    if (seen) localStorage.setItem("hfy:edge-session", "1");
    if (legacyToken) {
      // a release-1 Google ID token left in localStorage (decodable, long expired): legacy HFY_AUTH reports signedIn
      const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, "");
      localStorage.setItem("HFY_AUTH_ID_TOKEN", `${b64({ alg: "none" })}.${b64({ email: "tester@example.test", sub: "t", exp: 1 })}.sig`);
    }
  }, { legacyToken, seen });
  return log;
}

test("hourly lapse: the person page refreshes io_id once before fetching and renders, with no trip to /auth/login", async ({ page }) => {
  const log = await edge(page, { session: (n) => (n === 1 ? { authenticated: false } : { authenticated: true, sub: "I9001", grampsId: "I9001", label: "Test" }), gate: "lapsed" });
  await page.goto(PERSON_PATH, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-content h1")).toHaveText("Test Person (synthetic)");
  expect(log.refresh).toEqual([{ method: "POST", xrw: "io-kit" }]);
  expect(log.login).toBe(0);
  expect(log.data.filter((d) => d.url === "/person/I9001.json")).toEqual([{ url: "/person/I9001.json", session: null }]);
  expect(new URL(page.url()).pathname).toBe("/person/");
});

test("gate 401 mid-session: refreshed once, the request retried once, the record renders", async ({ page }) => {
  const log = await edge(page, { gate: "lapsed" }); // /auth/session still says authenticated (clock skew / cookie dropped)
  await page.goto(PERSON_PATH, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-content h1")).toHaveText("Test Person (synthetic)");
  expect(log.refresh.length).toBe(1);
  expect(log.data.filter((d) => d.url === "/person/I9001.json").length).toBe(2);
  expect(log.login).toBe(0);
});

test("refresh token gone: sent to /auth/login once; back in the same tab and still denied, a sign-in link instead of a loop", async ({ page }) => {
  const log = await edge(page, { session: () => ({ authenticated: false }), refresh: 401, gate: "closed" });
  await page.goto(PERSON_PATH, { waitUntil: "domcontentloaded" });
  await page.waitForURL((u) => u.pathname === "/auth/login");
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/person/?id=I9001&hfy_flags=authV2");
  expect(log.refresh.length).toBe(1);
  // the visitor comes back without a working session: no second automatic redirect
  await page.goto(PERSON_PATH, { waitUntil: "domcontentloaded" });
  const err = page.locator("#person-error");
  await expect(err).toContainText("Your sign-in has expired.");
  await expect(err.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/auth/login?returnTo=" + encodeURIComponent("/person/?id=I9001&hfy_flags=authV2"));
  await page.waitForTimeout(500);
  expect(new URL(page.url()).pathname).toBe("/person/");
  expect(log.login).toBe(1);
});

test("islands: searchV2 corpus seed over a lapsed session refreshes once and lists results (rebuilt search bundle)", async ({ page }) => {
  const log = await edge(page, { gate: "lapsed" });
  await page.goto("/search/?q=Quillfeather&hfy_flags=authV2,searchV2", { waitUntil: "domcontentloaded" });
  const root = page.locator("#hfy-search-v2");
  await expect(root.getByRole("link", { name: /Mary Quillfeather/ })).toBeVisible({ timeout: 10_000 });
  expect(log.refresh.length).toBe(1);
  expect(log.login).toBe(0);
  expect(log.data.every((d) => d.session === null)).toBe(true);
});

test("islands: personV2 notes fetch goes through dataFetch (refresh + retry, never a redirect)", async ({ page }) => {
  const log = await edge(page, { gate: "lapsed" });
  await page.route("**/api/comments**", (r) => r.fulfill({ json: { thread: { id: "person:I9001", topic: "comments", comments: [], reactions: {} } } }));
  await page.goto("/person/?id=I9001&hfy_flags=authV2,personV2", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#hfy-notes-v2 h1")).toHaveText("Early life");
  expect(log.refresh.length).toBe(1);
  expect(log.login).toBe(0);
  expect(log.data.filter((d) => d.url === "/person/I9001.json").every((d) => d.session === null)).toBe(true);
});

test.describe("desktop navbar", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("public page with only a stale release-1 token: no data preload, no redirect, no refresh for a never-signed-in browser", async ({ page }) => {
    const log = await edge(page, { session: () => ({ authenticated: false }), gate: "closed", legacyToken: true });
    await page.goto("/about/?hfy_flags=authV2");
    await page.waitForTimeout(1200);
    expect(new URL(page.url()).pathname).toBe("/about/");
    expect(log.data).toEqual([]);
    expect(log.refresh).toEqual([]);
    expect(log.login).toBe(0);
  });

  test("public page, lapsed member whose refresh token is gone: one refresh, still no preload and no redirect", async ({ page }) => {
    const log = await edge(page, { session: () => ({ authenticated: false }), refresh: 401, gate: "closed", legacyToken: true, seen: true });
    await page.goto("/about/?hfy_flags=authV2");
    await page.waitForTimeout(1200);
    expect(new URL(page.url()).pathname).toBe("/about/");
    expect(log.refresh.length).toBe(1);
    expect(log.data).toEqual([]);
    expect(log.login).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem("hfy:edge-session"))).toBeNull();
  });

  test("edge-only sign-in (no legacy token): navbar search, My Record and Log out show, and search suggests over the cookie", async ({ page }) => {
    const log = await edge(page);
    await page.goto("/about/?hfy_flags=authV2");
    const input = page.locator("[data-search-form] [data-search-input]");
    await expect(input).toBeVisible();
    await expect(page.locator('[data-feature="myRecordLink"]')).toBeVisible();
    await expect(page.locator('[data-feature="logoutLink"]')).toBeVisible();
    await expect(page.locator('[data-feature="familyLoginLink"]')).toBeHidden();
    // legacy auth.js settles later (no stored token) and must not hide them again
    await page.waitForTimeout(900);
    await expect(input).toBeVisible();
    await input.fill("Quill");
    await expect(page.locator("[data-search-list] [data-search-option]", { hasText: "Mary Quillfeather" })).toBeVisible({ timeout: 10_000 });
    expect(log.data.length).toBeGreaterThan(0);
    expect(log.data.every((d) => d.session === null)).toBe(true);
    expect(log.session).toBe(1);
  });

  test("lapsed member on a public page: refreshed once, navigation shows the signed-in state", async ({ page }) => {
    const log = await edge(page, { session: (n) => (n === 1 ? { authenticated: false } : { authenticated: true, sub: "I9001", grampsId: "I9001", label: "Test" }), gate: "lapsed", seen: true });
    await page.goto("/about/?hfy_flags=authV2");
    await expect(page.locator("[data-search-form] [data-search-input]")).toBeVisible();
    await expect(page.locator("[data-my-record-link]")).toHaveAttribute("href", "/person/?id=I9001");
    expect(log.refresh.length).toBe(1);
    expect(log.login).toBe(0);
  });

  test("flag off (parity): no /auth/session or /auth/refresh, legacy X-HFY-Session data requests", async ({ page }) => {
    const log = await edge(page);
    await page.addInitScript(() => {
      try { sessionStorage.setItem("HFY_GATEWAY_SESSION_V1", JSON.stringify({ token: "legacy-token", grampsId: "I9001", expiresAt: Date.now() + 3600e3, verifiedAt: Date.now() })); } catch {}
    });
    await page.goto("/person/?id=I9001", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#person-content h1")).toHaveText("Test Person (synthetic)");
    await page.waitForTimeout(500);
    expect(log.session).toBe(0);
    expect(log.refresh).toEqual([]);
    expect(log.data.find((d) => d.url === "/person/I9001.json").session).toBe("legacy-token");
  });
});
