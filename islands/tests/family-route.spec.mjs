// The family tab is "your family": it opens the signed-in member's own page, /person/?id=<edge session sub = gramps id>, and a
// signed-out visitor goes to the sign-in, which returns to /private/ (the stable family route, a redirect page) and then to the
// own page. /person/ without an id does the same; the 2025 dev scaffold that /private/ used to be is gone. With navMe (HFY-TSK-091,
// turned on here with the ?hfy_flags preview override) the same own-page tab is "me", and "family" leaves the bar.
// /auth and /api are stubbed; the person data answers 404 (only the shell and the redirects are under test). Run against the committed
// site (../11ty on 8089) or a scratch build: HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/family-route.spec.mjs
import { test, expect } from "@playwright/test";

const SUB = "I0042";
const OTHER = "I0099";
const OWN = `/person/?id=${SUB}`;

async function hermetic(page, { session = "in", flags } = {}) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  if (flags) await page.route("**/_data/flags.json", (r) => r.fulfill({ json: flags }));
  await page.route("**/auth/session", (r) => {
    if (session === "unreachable") return r.fulfill({ status: 503, body: "down" });
    return r.fulfill({ json: session === "in" ? { authenticated: true, sub: SUB, grampsId: SUB, label: "Marie" } : { authenticated: false } });
  });
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/auth/login**", (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>sign in</title><p>edge sign-in</p>" }));
  await page.route("**/api/**", (r) => r.fulfill({ status: 401, json: { error: "unauthenticated" } }));
  await page.route(/\/person\/[^/]+\.json/, (r) => r.fulfill({ status: 404, json: { error: "not found" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
}

const bottom = (page, id) => page.locator(`#hfy-shell-root .io-nav__item--bar[data-io-nav-item="${id}"]`);
const top = (page, label) => page.locator("#hfy-shell-root .hfy-bar__links a", { hasText: new RegExp(`^${label}$`) });
const shellUp = (page) => expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();

// -------------------------------------------------------------------------------------------------------------- the tab's href
for (const [name, width] of [["bottom bar", 375], ["top bar", 1024]]) {
  const family = (page) => (width < 688 ? bottom(page, "family") : top(page, "family"));

  test(`${name}: signed in, the family tab links to the member's own page`, async ({ page }) => {
    await hermetic(page);
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/about/", { waitUntil: "domcontentloaded" });
    await shellUp(page);
    await expect(family(page)).toHaveAttribute("href", OWN);
    // the account menu's "your page" is the same URL
    await page.locator('[data-hfy-account="signed-in"]').click();
    await expect(page.getByRole("link", { name: "your page" })).toHaveAttribute("href", OWN);
  });

  test(`${name}: signed out, the family tab is the stable /private/ route (never /family/, a gated data prefix)`, async ({ page }) => {
    await hermetic(page, { session: "out" });
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/about/", { waitUntil: "domcontentloaded" });
    await shellUp(page);
    await expect(page.locator('[data-hfy-account="signed-out"]')).toBeVisible();
    await expect(family(page)).toHaveAttribute("href", "/private/");
    for (const href of await page.locator("#hfy-shell-root nav a[href]").evaluateAll((els) => els.map((e) => e.getAttribute("href")))) expect(href).not.toMatch(/^\/family\//);
  });

  test(`${name}: /auth/session unreachable, the family tab is still /private/`, async ({ page }) => {
    await hermetic(page, { session: "unreachable" });
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/about/", { waitUntil: "domcontentloaded" });
    await shellUp(page);
    await expect(family(page)).toHaveAttribute("href", "/private/");
  });
}

// ---------------------------------------------------------------------------------------------------------------- aria-current
for (const [name, width] of [["bottom bar", 375], ["top bar", 1024]]) {
  const family = (page) => (width < 688 ? bottom(page, "family") : top(page, "family"));
  const current = (page) => (width < 688 ? page.locator('#hfy-shell-root .io-nav__item--bar[aria-current="page"]') : page.locator('#hfy-shell-root .hfy-bar__links a[aria-current="page"]'));

  test(`${name}: the family tab is current on the member's own page, and only there`, async ({ page }) => {
    await hermetic(page);
    await page.setViewportSize({ width, height: 800 });
    await page.goto(OWN, { waitUntil: "domcontentloaded" });
    await shellUp(page);
    await expect(current(page)).toHaveCount(1);
    await expect(current(page)).toContainText("family");
    // the other tabs are not marked
    for (const id of ["home", "search", "posts", "me"]) await expect(width < 688 ? bottom(page, id) : top(page, id)).not.toHaveAttribute("aria-current", "page");
  });

  test(`${name}: another person's page marks no tab (family is not it, and search would be a guess)`, async ({ page }) => {
    await hermetic(page);
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/person/?id=${OTHER}`, { waitUntil: "domcontentloaded" });
    await shellUp(page);
    await expect(family(page)).toHaveAttribute("href", OWN); // the session has resolved: the tab names the member's own page
    await expect(current(page)).toHaveCount(0);
  });

}

test("a signed-out visitor's person page marks no tab either", async ({ page }) => {
  await hermetic(page, { session: "out" });
  await page.goto(`/person/?id=${OTHER}`, { waitUntil: "domcontentloaded" });
  await shellUp(page);
  await expect(page.locator('#hfy-shell-root [aria-current="page"]')).toHaveCount(0);
});

test("the other sections still mark their own tab (search)", async ({ page }) => {
  await hermetic(page);
  await page.goto("/search/", { waitUntil: "domcontentloaded" });
  await shellUp(page);
  await expect(page.locator('#hfy-shell-root .io-nav__item--bar[aria-current="page"]')).toHaveCount(1);
  await expect(bottom(page, "search")).toHaveAttribute("aria-current", "page");
});

// ------------------------------------------------------------------------------------------- navMe: "me" is the own page (HFY-TSK-091)
// With navMe the own-page tab is "me" (lib/nav.js navItems) and "family" leaves the bar until familyViz; the rules above apply to it.
const NAVME = "hfy_flags=navMe";
for (const [name, width] of [["bottom bar", 375], ["top bar", 1024]]) {
  const me = (page) => (width < 688 ? bottom(page, "me") : top(page, "me"));
  const current = (page) => (width < 688 ? page.locator('#hfy-shell-root .io-nav__item--bar[aria-current="page"]') : page.locator('#hfy-shell-root .hfy-bar__links a[aria-current="page"]'));

  test(`${name} navMe: signed in, "me" links to the member's own page (the account sheet's "your page" too); no family tab`, async ({ page }) => {
    await hermetic(page);
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/about/?${NAVME}`, { waitUntil: "domcontentloaded" });
    await shellUp(page);
    await expect(me(page)).toHaveAttribute("href", OWN);
    await expect(width < 688 ? bottom(page, "family") : top(page, "family")).toHaveCount(0);
    await page.locator('[data-hfy-account="signed-in"]').click();
    await expect(page.getByRole("link", { name: "your page" })).toHaveAttribute("href", OWN);
  });

  test(`${name} navMe: signed out or session unreachable, "me" is the stable /private/ route (never /family/)`, async ({ page }) => {
    for (const session of ["out", "unreachable"]) {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await hermetic(page, { session });
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/about/?${NAVME}`, { waitUntil: "domcontentloaded" });
      await shellUp(page);
      await expect(me(page)).toHaveAttribute("href", "/private/");
      for (const href of await page.locator("#hfy-shell-root nav a[href]").evaluateAll((els) => els.map((e) => e.getAttribute("href")))) expect(href).not.toMatch(/^\/family\//);
    }
  });

  test(`${name} navMe: "me" is current on the member's own page, and only there`, async ({ page }) => {
    await hermetic(page);
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${OWN}&${NAVME}`, { waitUntil: "domcontentloaded" });
    await shellUp(page);
    await expect(me(page)).toHaveAttribute("href", OWN);
    await expect(current(page)).toHaveCount(1);
    await expect(current(page)).toContainText("me");
    await page.goto(`/person/?id=${OTHER}`, { waitUntil: "domcontentloaded" }); // the override persists in this tab
    await shellUp(page);
    await expect(me(page)).toHaveAttribute("href", OWN);
    await expect(current(page)).toHaveCount(0);
  });
}

test("navMe signed out: 'me' goes to the edge sign-in and, signed in, back to the member's own page", async ({ page }) => {
  let signedIn = false;
  await hermetic(page, { session: "out" });
  await page.route("**/auth/session", (r) => r.fulfill({ json: signedIn ? { authenticated: true, sub: SUB, grampsId: SUB, label: "Marie" } : { authenticated: false } }));
  await page.goto(`/about/?${NAVME}`, { waitUntil: "domcontentloaded" });
  await shellUp(page);
  await expect(page.locator('[data-hfy-account="signed-out"]')).toBeVisible();
  await bottom(page, "me").click();
  await page.waitForURL((u) => u.pathname === "/auth/login" && u.searchParams.get("returnTo") === "/private/");
  signedIn = true; // the sign-in finished and returns to /private/
  await page.goto("/private/", { waitUntil: "domcontentloaded" });
  await page.waitForURL((u) => u.pathname === "/person/" && u.searchParams.get("id") === SUB);
});

// --------------------------------------------------------------------------------------------------- /private/ is a redirect page
test("/private/ signed in: goes to the member's own page (history replaced)", async ({ page }) => {
  await hermetic(page);
  await page.goto("/about/", { waitUntil: "domcontentloaded" });
  await page.goto("/private/", { waitUntil: "domcontentloaded" });
  await page.waitForURL((u) => u.pathname === "/person/" && u.searchParams.get("id") === SUB);
  await page.goBack();
  expect(new URL(page.url()).pathname, "Back skips the redirecting page").toBe("/about/");
});

test("/private/ signed out: goes to the edge sign-in, returning to /private/", async ({ page }) => {
  await hermetic(page, { session: "out" });
  await page.goto("/private/", { waitUntil: "domcontentloaded" });
  await page.waitForURL((u) => u.pathname === "/auth/login" && u.searchParams.get("returnTo") === "/private/");
});

test("after the sign-in comes back to /private/, the member lands on the own page", async ({ page }) => {
  let signedIn = false;
  await hermetic(page, { session: "out" });
  await page.route("**/auth/session", (r) => r.fulfill({ json: signedIn ? { authenticated: true, sub: SUB, grampsId: SUB, label: "Marie" } : { authenticated: false } }));
  await page.goto("/private/", { waitUntil: "domcontentloaded" });
  await page.waitForURL((u) => u.pathname === "/auth/login");
  signedIn = true; // the sign-in finished
  await page.goto("/private/", { waitUntil: "domcontentloaded" });
  await page.waitForURL((u) => u.pathname === "/person/" && u.searchParams.get("id") === SUB);
});

test("/private/ with authV2 off: the legacy sign-in hands the id over; no stored id goes to /family-login/ with next", async ({ page }) => {
  const flags = { authV2: false, shellV2: true, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false };
  await hermetic(page, { session: "unreachable", flags });
  await page.goto("/private/", { waitUntil: "domcontentloaded" });
  await page.waitForURL((u) => u.pathname === "/family-login/" && u.searchParams.get("next") === "/private/");
  await page.evaluate(() => localStorage.setItem("HFY_AUTH_USER_GRAMPS_ID", "I0042"));
  await page.goto("/private/", { waitUntil: "domcontentloaded" });
  await page.waitForURL((u) => u.pathname === "/person/" && u.searchParams.get("id") === "I0042");
});

test("/private/ holds no directory: no cards, no sample person, no media, a noscript sign-in link", async ({ page }) => {
  await hermetic(page);
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, label: "Marie" } })); // no sub: it cannot decide, so it stays
  await page.goto("/private/", { waitUntil: "domcontentloaded" });
  await shellUp(page);
  await expect(page.locator("[data-family-fallback]")).toBeVisible();
  const main = page.locator("main");
  await expect(main.locator(".card, img")).toHaveCount(0);
  const text = (await main.innerText()).toLowerCase();
  expect(text).not.toMatch(/sample person|local development|person directory|view profile/);
  // (with scripting on, <noscript> is not parsed into elements: read the served HTML)
  const served = await (await page.request.get("/private/")).text();
  expect(served).toMatch(/<noscript><p class="mb-0"><a href="\/auth\/login\?returnTo=%2Fprivate%2F">sign in to see your family<\/a><\/p><\/noscript>/);
});

// ------------------------------------------------------------------------------------------------------ /person/ without an id
test("/person/ with no id, signed in: goes to the own page", async ({ page }) => {
  await hermetic(page);
  await page.goto("/person/", { waitUntil: "domcontentloaded" });
  await page.waitForURL((u) => u.pathname === "/person/" && u.searchParams.get("id") === SUB);
});

test("/person/?id= (empty), signed in: goes to the own page", async ({ page }) => {
  await hermetic(page);
  await page.goto("/person/?id=", { waitUntil: "domcontentloaded" });
  await page.waitForURL((u) => u.pathname === "/person/" && u.searchParams.get("id") === SUB);
});

test("/person/ with no id, signed out: goes to the edge sign-in, returning to /private/", async ({ page }) => {
  await hermetic(page, { session: "out" });
  await page.goto("/person/", { waitUntil: "domcontentloaded" });
  await page.waitForURL((u) => u.pathname === "/auth/login" && u.searchParams.get("returnTo") === "/private/");
});

test("/person/ with no id never sits on 'loading' when it cannot decide: a session without a gramps id shows the one error line", async ({ page }) => {
  await hermetic(page);
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, label: "Marie" } })); // no sub
  await page.goto("/person/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-error")).toContainText("that didn't work");
  await expect(page.locator("#person-loading")).toBeHidden();
  expect(new URL(page.url()).pathname).toBe("/person/");
});
