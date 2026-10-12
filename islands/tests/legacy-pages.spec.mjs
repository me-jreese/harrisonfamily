// HFY design-system pass (legacy area): the Eleventy pages under the static theme (/css/hfy-theme.css: theme.css, the bridges and
// the 30-bootstrap / 40-site partials), at 375 / 688 / 1024 with shellV2 on and off. Synthetic data only; /auth, /api, the flags
// file and media are stubbed by route interception. Run against a site built with `node build.mjs --site <dir>`:
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/legacy-pages.spec.mjs
import { test, expect } from "@playwright/test";

const PAGES = ["/", "/about/", "/contact/", "/privacy/", "/private/", "/logged-out/"];
const WIDTHS = [375, 688, 1024];
const GROUND = "rgb(20, 18, 16)"; // surface = archive-950 #141210
const LINK = "rgb(88, 182, 231)"; // link / accent = columbia-400
const GOLD = "rgb(255, 193, 7)"; // link.hover / focus = gold-400
const TEXT_DIM = "rgb(205, 191, 166)"; // text.dim = archive-300
// main.css / Enceladus literals that must never be painted once the theme applies
const LITERALS = ["7, 17, 28", "10, 10, 15", "17, 24, 39", "61, 155, 168"];

async function stub(page, { shell }) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: shell, personV2: false, postsV2: false, searchV2: false, notifyV2: false } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: false } }));
  await page.route("**/api/**", (r) => r.fulfill({ status: 401, json: { error: "unauthenticated" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route(/\/media\/[^?]*\.(jpe?g|png|webp)/, (r) => r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="gray"/></svg>' }));
}

async function open(page, path, shell) {
  await page.goto(path, { waitUntil: "load" });
  if (shell) {
    await expect(page.locator("html")).toHaveClass(/hfy-shell-v2/);
    await page.waitForSelector(".io-shell");
  } else {
    await expect(page.locator("nav.navbar-hf")).toBeVisible();
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
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

for (const shell of [true, false]) {
  for (const width of WIDTHS) {
    for (const path of PAGES) {
      test(`${path} at ${width}px, shellV2 ${shell ? "on" : "off"}: themed ground, type, controls, links, footer`, async ({ page }) => {
        await stub(page, { shell });
        await page.setViewportSize({ width, height: 900 });
        await open(page, path, shell);

        const facts = await page.evaluate(([literals, shellOn]) => {
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity) > 0;
          };
          const scope = [...document.querySelectorAll("main, footer.site-footer" + (shellOn ? "" : ", nav.navbar-hf"))];
          const inScope = scope.flatMap((root) => [root, ...root.querySelectorAll("*")]).filter(visible);
          const painted = [];
          for (const el of [document.documentElement, document.body, ...document.body.querySelectorAll("*")]) {
            if (el !== document.documentElement && el !== document.body && !visible(el)) continue;
            const s = getComputedStyle(el);
            const colours = [["color", s.color], ["background-color", s.backgroundColor]];
            for (const side of ["Top", "Right", "Bottom", "Left"]) if (parseFloat(s[`border${side}Width`]) > 0) colours.push([`border-${side.toLowerCase()}`, s[`border${side}Color`]]);
            for (const [prop, value] of colours) {
              const m = value.match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/);
              if (!m || m[4] === "0") continue;
              if (literals.includes(`${m[1]}, ${m[2]}, ${m[3]}`)) painted.push(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")} ${prop} ${value}`);
            }
          }
          const small = [];
          for (const el of inScope) {
            const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
            if (!hasText) continue;
            const size = parseFloat(getComputedStyle(el).fontSize);
            if (size < 15.99) small.push(`${el.tagName.toLowerCase()}.${[...el.classList].join(".")} ${size}px "${el.textContent.trim().slice(0, 30)}"`);
          }
          const h1 = [...document.querySelectorAll("main h1")].find(visible);
          const footer = document.querySelector("footer.site-footer");
          const footerText = document.querySelector(".site-footer__text");
          const links = [...document.querySelectorAll("main a[href]:not(.btn)")].filter(visible).map((a) => getComputedStyle(a).color);
          const buttons = [...document.querySelectorAll("main .btn")].filter(visible).map((b) => ({ text: b.textContent.trim(), radius: getComputedStyle(b).borderTopLeftRadius, h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width }));
          return {
            ground: getComputedStyle(document.body).backgroundColor,
            painted,
            small,
            h1Font: h1 ? getComputedStyle(h1).fontFamily : null,
            links,
            buttons,
            footer: footer && { position: getComputedStyle(footer).position, size: getComputedStyle(footerText).fontSize, color: getComputedStyle(footerText).color, transform: getComputedStyle(footerText).textTransform, opacity: getComputedStyle(footerText).opacity },
            hscroll: document.documentElement.scrollWidth > window.innerWidth + 1 || [...document.querySelectorAll("[data-io-scroller]")].some((s) => s.scrollWidth > s.clientWidth + 1)
          };
        }, [LITERALS, shell]);

        expect(facts.ground, "body ground is surface (archive-950)").toBe(GROUND);
        expect(facts.painted, "no main.css / Enceladus literal is painted").toEqual([]);
        expect(facts.small, "no visible text under 16px").toEqual([]);
        expect(facts.hscroll, "no horizontal scroll").toBe(false);
        if (path !== "/contact/") expect(facts.h1Font, "h1 is the display serif").toMatch(/^"?Libre Caslon Text"?,/);
        for (const color of facts.links) expect(color, "links are the Columbia link colour").toBe(LINK);
        for (const b of facts.buttons) {
          expect(b.radius, `.btn "${b.text}" radius.md`).toBe("8px");
          expect(b.h, `.btn "${b.text}" height`).toBeGreaterThanOrEqual(44);
          expect(b.w, `.btn "${b.text}" width`).toBeGreaterThanOrEqual(44);
        }
        expect(facts.footer.size).toBe("16px");
        expect(facts.footer.color, "footer text is text.dim").toBe(TEXT_DIM);
        expect(facts.footer.transform).toBe("none");
        expect(facts.footer.opacity).toBe("1");
        if (shell) expect(facts.footer.position, "footer is static under the shell").toBe("static");

        if (path === "/") {
          // the gold hero CTA is now the Columbia accent, with accent.text ink at >= 4.5:1
          const cta = page.locator(".home-hero .btn-warning");
          await expect(cta).toBeVisible();
          expect(await cta.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(LINK);
          const ratio = await cta.evaluate((el, src) => eval(`(${src})`)()(el), CONTRAST.toString());
          expect(ratio, "CTA text contrast").toBeGreaterThanOrEqual(4.5);
          if (width < 688) expect((await cta.boundingBox()).height, "phone CTA is control.h.lg").toBeGreaterThanOrEqual(56);
          await expect(page.locator(".home-hero h1:empty")).toBeHidden();
        }

        const btn = page.locator("main .btn:visible").first();
        if (await btn.count()) {
          // one focus rule: a solid 2px gold ring, no Bootstrap glow, no gold fill
          await btn.focus();
          await page.keyboard.press("Shift+Tab");
          await page.keyboard.press("Tab");
          const ring = await page.evaluate(() => {
            const el = document.activeElement;
            const s = getComputedStyle(el);
            return { btn: el.classList.contains("btn"), style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, shadow: s.boxShadow, bg: s.backgroundColor };
          });
          expect(ring.btn, "keyboard focus lands back on the .btn").toBe(true);
          expect(ring).toMatchObject({ style: "solid", width: "2px", color: GOLD, shadow: "none" });
          expect(ring.bg).not.toBe(GOLD);
        }

        const link = page.locator("main a[href]:not(.btn):visible").first();
        if (await link.count()) {
          await link.hover();
          await expect.poll(() => link.evaluate((a) => getComputedStyle(a).color), { message: "link hover is gold" }).toBe(GOLD);
        }
      });
    }
  }
}

test("/contact/ footer-row links are 44px tap targets", async ({ page }) => {
  await stub(page, { shell: true });
  await open(page, "/contact/", true);
  for (const a of await page.locator("main a.link-light").all()) expect((await a.boundingBox()).height).toBeGreaterThanOrEqual(44);
});

test("/private/: card badges read as a text.dim word, View Profile reaches 44px", async ({ page }) => {
  await stub(page, { shell: true });
  await open(page, "/private/", true);
  const badge = page.locator(".card-body > .badge").first();
  const s = await badge.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, size: getComputedStyle(el).fontSize, text: el.textContent.trim() }));
  expect(s).toMatchObject({ bg: "rgba(0, 0, 0, 0)", color: TEXT_DIM, size: "16px" });
  for (const b of await page.locator(".card .btn-sm").all()) expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(44);
});

test("legacy navbar (shellV2 off): nav.tint bar, text.dim links, never the bs-bridge nav.tint ink", async ({ page }) => {
  await stub(page, { shell: false });
  await page.setViewportSize({ width: 1024, height: 800 });
  await open(page, "/about/", false);
  const nav = await page.evaluate(() => {
    const bar = document.querySelector("nav.navbar-hf");
    const link = [...bar.querySelectorAll(".nav-link")].find((a) => a.getBoundingClientRect().width > 0 && !a.classList.contains("active"));
    return { bg: getComputedStyle(bar).backgroundColor, blur: getComputedStyle(bar).backdropFilter, link: getComputedStyle(link).color, size: getComputedStyle(link).fontSize, transform: getComputedStyle(link).textTransform };
  });
  expect(nav.bg).toBe("rgba(88, 182, 231, 0.2)");
  expect(nav.blur).toBe("blur(8px)");
  expect(nav.link).toBe(TEXT_DIM);
  expect(nav.size).toBe("16px");
  expect(nav.transform).toBe("lowercase");
});
