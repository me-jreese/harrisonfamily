// Site sweep: the quiet footer links (the shell hides the navbar that linked about and contact; nothing linked privacy or terms), the
// /logged-out/ page in the family voice, the home "sign in" button going straight to the edge sign-in under authV2, and the
// /family-login/ copy that flashes before that redirect. /auth and /api are stubbed. Run against the committed site (../11ty on 8089).
import { test, expect } from "@playwright/test";

const LINKS = [["about", "/about/"], ["contact", "/contact/"], ["privacy", "/privacy/"], ["terms", "/terms/"]];
const FOOTER_PAGES = ["/", "/about/", "/contact/", "/privacy/", "/terms/", "/search/", "/posts/", "/me/", "/me/notifications/", "/logged-out/"];

async function hermetic(page, { session = "out", flags } = {}) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  if (flags) await page.route("**/_data/flags.json", (r) => r.fulfill({ json: flags }));
  await page.route("**/auth/session", (r) => (session === "unreachable" ? r.fulfill({ status: 503, body: "down" }) : r.fulfill({ json: session === "in" ? { authenticated: true, sub: "I0042", label: "Marie" } : { authenticated: false } })));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/auth/login**", (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>sign in</title><p>edge sign-in</p>" }));
  await page.route("**/api/**", (r) => r.fulfill({ status: 401, json: { error: "unauthenticated" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
}

// WCAG contrast of an element's text against what is really painted behind it (backgrounds composited up the ancestor chain).
const CONTRAST = () => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (t, b) => { const a = t.a + b.a * (1 - t.a); return a === 0 ? { r: 0, g: 0, b: 0, a: 0 } : { r: (t.r * t.a + b.r * b.a * (1 - t.a)) / a, g: (t.g * t.a + b.g * b.a * (1 - t.a)) / a, b: (t.b * t.a + b.b * b.a * (1 - t.a)) / a, a }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  return (el) => {
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    const chain = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) chain.push(n);
    for (const n of chain.reverse()) { const bg = parse(getComputedStyle(n).backgroundColor); if (bg.a > 0) acc = over(bg, acc); }
    const fg = over(parse(getComputedStyle(el).color), acc);
    const x = lum(fg), y = lum(acc);
    return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100;
  };
};

for (const width of [375, 1024]) {
  for (const path of FOOTER_PAGES) {
    test(`${path} at ${width}: the footer carries about, contact, privacy and terms (44px targets, AA contrast, no h-scroll)`, async ({ page }) => {
      await hermetic(page);
      await page.setViewportSize({ width, height: 800 });
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
      const nav = page.locator("footer.site-footer nav.site-footer__links");
      await expect(nav).toHaveCount(1);
      await expect(nav).toHaveAttribute("aria-label", "about this site");
      const links = nav.locator("a");
      await expect(links).toHaveCount(4);
      await links.last().scrollIntoViewIfNeeded();
      for (const [i, [label, href]] of LINKS.entries()) {
        await expect(links.nth(i)).toHaveText(label);
        await expect(links.nth(i)).toHaveAttribute("href", href);
        const box = await links.nth(i).boundingBox();
        expect(box.height, `${label} height`).toBeGreaterThanOrEqual(43.5);
        expect(box.width, `${label} width`).toBeGreaterThanOrEqual(43.5);
        const ratio = await links.nth(i).evaluate((el, src) => eval(`(${src})`)()(el), CONTRAST.toString());
        expect(ratio, `${label} contrast`).toBeGreaterThanOrEqual(4.5);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}

test("every footer link target is a page that exists", async ({ page }) => {
  for (const [, href] of LINKS) expect((await page.request.get(href)).status(), href).toBe(200);
});

test("the footer links are plain text in the served HTML (no JS needed), once per page", async ({ page }) => {
  for (const path of FOOTER_PAGES) {
    const html = await (await page.request.get(path)).text();
    expect(html.match(/class="site-footer__links"/g)?.length, path).toBe(1);
  }
});

test("/logged-out/ speaks in the family voice and signs in again at the edge", async ({ page }) => {
  await hermetic(page);
  await page.goto("/logged-out/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("main h1")).toHaveText("you're signed out.");
  await expect(page.getByRole("link", { name: "sign in again" })).toHaveAttribute("href", "/auth/login");
  await expect(page.getByRole("link", { name: "home", exact: true }).first()).toHaveAttribute("href", "/");
  const text = (await page.locator("main").innerText());
  expect(text).not.toMatch(/Family Login|Return to|Back to Home|You are signed out|ended successfully/);
  expect(text).toBe(text.toLowerCase());
});

test("home: the hero 'sign in' goes straight to /auth/login?returnTo=/ once the edge says signed out", async ({ page }) => {
  await hermetic(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const button = page.locator('main a.btn[data-feature="familyLoginLink"]');
  await expect(button).toHaveText("sign in");
  await expect(button).toHaveAttribute("href", "/auth/login?returnTo=%2F");
});

test("home: /auth/session unreachable, the hero 'sign in' keeps the legacy /family-login/ entry", async ({ page }) => {
  await hermetic(page, { session: "unreachable" });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const button = page.locator('main a.btn[data-feature="familyLoginLink"]');
  await expect(button).toHaveAttribute("href", "/family-login/");
  await page.waitForTimeout(500);
  await expect(button).toHaveAttribute("href", "/family-login/");
});

test("/family-login/ shows family-voice copy while it waits (authV2 off, so it stays)", async ({ page }) => {
  await hermetic(page, { session: "unreachable", flags: { authV2: false, shellV2: true, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false } });
  await page.goto("/family-login/", { waitUntil: "domcontentloaded" });
  const card = page.locator("main .card-body");
  await expect(card).toContainText("sign in with your Google account to see the family pages.");
  await expect(card).toContainText("not on the list yet? text J.");
  const text = await card.innerText();
  expect(text).not.toMatch(/approved Google account|site administrator|authentication status|Please sign in/);
});

test("the meta description is in the family voice on every page that had the Eleventy default", async ({ page }) => {
  for (const path of ["/search/", "/family-login/", "/logged-out/", "/person/", "/private/"]) {
    const html = await (await page.request.get(path)).text();
    expect(html, path).toContain('<meta name="description" content="the Harrison family archive. family members sign in to see the private pages." />');
    expect(html, path).not.toMatch(/gramps, 11ty and bootstrap/);
  }
});

test("the obfuscated address reads [DOT] (the zero is fixed) on contact, privacy and terms", async ({ page }) => {
  for (const path of ["/contact/", "/privacy/", "/terms/"]) {
    const html = await (await page.request.get(path)).text();
    expect(html, path).toContain("info [@] harrisonfamily [DOT] us");
    expect(html, path).not.toContain("[D0T]");
  }
});
