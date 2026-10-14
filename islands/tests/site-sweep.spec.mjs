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

test("home: /auth/session unreachable, the hero 'sign in' keeps its static /auth/login entry", async ({ page }) => {
  await hermetic(page, { session: "unreachable" });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const button = page.locator('main a.btn[data-feature="familyLoginLink"]');
  await expect(button).toHaveAttribute("href", "/auth/login");
  await page.waitForTimeout(500);
  await expect(button).toHaveAttribute("href", "/auth/login");
});

test("/family-login/ is a redirect page: a lowercase line, a sign-in link, and a no-script refresh to /auth/login (HFY-TSK-317)", async ({ page }) => {
  const html = await (await page.request.get("/family-login/")).text();
  const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  expect(main.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).toBe("taking you to sign in. sign in");
  expect(main).toContain('<a href="/auth/login">sign in</a>');
  expect(html).toContain('<noscript><meta http-equiv="refresh" content="0; url=/auth/login"></noscript>');
  expect(html).toContain('<meta name="robots" content="noindex">');
  expect(html).not.toMatch(/gsi\/client|auth\.js|feature-flags|check-allowed/);
});

test("the meta description is in the family voice on every page that had the Eleventy default", async ({ page }) => {
  for (const path of ["/search/", "/logged-out/", "/person/", "/private/"]) {
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

test("/privacy/ at 375: the section 4 tables keep every label and purpose word whole and stay inside the article", async ({ page }) => {
  await hermetic(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/privacy/");
  await page.evaluate(() => document.fonts.ready);
  const r = await page.evaluate(() => {
    const article = document.querySelector("article.privacy-policy");
    const tables = [...article.querySelectorAll("table")];
    const split = []; // words whose own range spans more than one line box; the last (retention) column may break one when it must
    for (const t of tables) for (const tr of t.querySelectorAll("tbody tr")) for (const cell of [...tr.cells].slice(0, -1)) {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let tn = walker.nextNode(); tn; tn = walker.nextNode()) {
        for (const m of tn.textContent.matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(tn, m.index);
          range.setEnd(tn, m.index + m[0].length);
          if (new Set([...range.getClientRects()].map((x) => Math.round(x.top))).size > 1) split.push(m[0]);
        }
      }
    }
    const right = article.getBoundingClientRect().right;
    return { tables: tables.length, split, wider: tables.filter((t) => t.getBoundingClientRect().right > right + 0.5).length, hscroll: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth };
  });
  expect(r.tables).toBe(2);
  expect(r.split, "label or purpose words split across lines").toEqual([]);
  expect(r.wider, "tables wider than the article").toBe(0);
  expect(r.hscroll, "page h-scroll").toBe(0);
});
