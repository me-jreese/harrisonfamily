// HFY-TSK-064 AC2/AC3 + the approved design system's Shell (ds/components/Shell, HFY-R13) at 375 / 688 / 1024.
// Run against a built site: `node build.mjs --site <dir>` then `HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/shell.spec.mjs`
// (defaults: the committed ../11ty on 8089). The build flags (11ty/_data/flags.json) are all on except navMe, which ships off, so "flag off" checks force
// -shellV2 through the ?hfy_flags preview override. /auth and Google are stubbed; data is synthetic.
import { test, expect } from "@playwright/test";
import { axeViolations } from "./axe.mjs";

const PAGES = ["/", "/about/", "/search/", "/contact/"]; // (/private/ redirects, so it has no shell to audit: tests/family-route.spec.mjs)
// The labels are a function of the flags (lib/nav.js navItems, HFY-TSK-091): navMe ships off, so the build flags give the five.
const labelsFor = ({ navMe = false, familyViz = false } = {}) => (navMe && !familyViz ? ["home", "search", "posts", "me"] : ["home", "family", "search", "posts", "me"]);
const LABELS = labelsFor();
const ME = { sub: "I0001", label: "Marie" };

async function hermetic(page, { signedIn = false } = {}) {
  const calls = [];
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/auth/session", (r) => r.fulfill({ json: signedIn ? { authenticated: true, sub: ME.sub, grampsId: ME.sub, label: ME.label } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/auth/logout", (r) => { calls.push(`${r.request().method()} /auth/logout`); return r.fulfill({ status: 204, body: "" }); });
  await page.route("**/api/**", (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/api/posts") return r.fulfill({ json: { items: [], cursor: null } });
    if (u.pathname.endsWith("/preferences")) return r.fulfill({ json: { enabled: true, types: {}, extra: {} } });
    return signedIn ? r.fulfill({ json: {} }) : r.fulfill({ status: 401, json: { error: "unauthenticated" } });
  });
  return calls;
}

// Every shell control (outside the relocated page) is a >= 44 x 44 target; every visible input is >= 16px; no horizontal scroll.
async function audit(page) {
  return page.evaluate(() => {
    const chrome = document.querySelector("#hfy-shell-root");
    const small = [];
    chrome.querySelectorAll("a[href], button, [role=button], input, select, textarea").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return; // not rendered
      if (el.closest(".hfy-content")) return; // the legacy page body is audited for inputs only
      if (r.height < 43.5 || r.width < 43.5) small.push(`${el.tagName} ${el.getAttribute("aria-label") || el.textContent.trim().slice(0, 20)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    });
    const smallInputs = [...document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea")]
      .filter((el) => el.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => el.outerHTML.slice(0, 60));
    const rail = document.querySelector(".io-shell__rail, .io-shell__sidebar");
    const rr = rail ? rail.getBoundingClientRect() : null;
    return { small, smallInputs, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, rail: rr ? `${rr.width}x${rr.height}` : null };
  });
}

const shell = (page) => page.locator("#hfy-shell-root .io-shell");

// ---------------------------------------------------------------------------------------------------------------- 375
for (const path of PAGES) {
  test(`375 ${path}: KitShell, five-item bottom bar (75 x 56 cells, 16px labels), no top links, 44px targets, no h-scroll`, async ({ page }) => {
    await hermetic(page);
    await page.goto(`${path}?hfy_flags=shellV2`, { waitUntil: "domcontentloaded" });
    await expect(shell(page)).toBeVisible();
    await expect(shell(page)).toHaveAttribute("data-bp", "compact");
    await expect(page.locator("nav.navbar-hf")).toBeHidden();
    const bar = page.locator("#hfy-shell-root nav.io-shell__bar");
    await expect(bar).toBeVisible();
    const items = bar.locator(".io-nav__item--bar");
    await expect(items).toHaveCount(5);
    for (const [i, label] of LABELS.entries()) await expect(items.nth(i)).toHaveAccessibleName(label);
    const cells = await items.evaluateAll((els) => els.map((e) => {
      const r = e.getBoundingClientRect();
      const label = e.querySelector(".io-nav__label");
      const icon = e.querySelector(".io-nav__icon").getBoundingClientRect();
      return { w: r.width, h: r.height, font: getComputedStyle(label).fontSize, weight: getComputedStyle(label).fontWeight, icon: `${icon.width}x${icon.height}` };
    }));
    for (const c of cells) {
      expect(Math.abs(c.w - 75), `cell width ${c.w}`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(c.h - 56), `cell height ${c.h}`).toBeLessThanOrEqual(0.5);
      expect(c.font).toBe("16px");
      expect(c.weight).toBe("600");
      expect(c.icon).toBe("24x24");
    }
    await expect(page.locator("#hfy-shell-root .hfy-bar__links")).toBeHidden();
    await expect(page.locator("#hfy-shell-root .io-search-launcher")).toBeHidden(); // search is a bottom-bar item under 688
    const a = await audit(page);
    expect(a.small, "targets < 44px").toEqual([]);
    expect(a.smallInputs, "inputs < 16px").toEqual([]);
    expect(a.scrollW).toBeLessThanOrEqual(a.innerW);
  });
}

// Dark-theme AAA (guide/05: 7:1 for every text pair in dark) on the nav tint composited over surface.
const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const TINT_ON_SURFACE = "rgb(34, 51, 59)"; // nav.tint rgba(88,182,231,.2) over surface #141210

test("375: the current page's bottom-bar item has a text label (AAA on the tint) and a gold icon", async ({ page }) => {
  await hermetic(page);
  await page.goto("/search/?hfy_flags=shellV2", { waitUntil: "domcontentloaded" });
  const current = page.locator('#hfy-shell-root .io-nav__item--bar[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAccessibleName("search");
  const s = await current.evaluate((e) => ({ color: getComputedStyle(e).color, icon: getComputedStyle(e.querySelector(".io-nav__icon")).backgroundColor, bg: getComputedStyle(e).backgroundColor }));
  // HFY override of the DS Shell pairing: link on the tint is 5.79:1 (< 7:1); the label is `text` and the gold icon marks it.
  expect(s.color).toBe("rgb(250, 246, 238)"); // text (archive-50)
  expect(ratio(s.color, TINT_ON_SURFACE)).toBeGreaterThanOrEqual(7);
  expect(s.icon).toBe("rgb(255, 193, 7)"); // accent.secondary (gold-400)
  expect(s.bg).toBe("rgba(0, 0, 0, 0)");
  const other = await page.locator('#hfy-shell-root .io-nav__item--bar[data-io-nav-item="home"]').evaluate((e) => getComputedStyle(e).color);
  expect(other).toBe("rgb(205, 191, 166)"); // text.dim (archive-300)
});

// ---------------------------------------------------------------------------------------------------------- 688 / 1024
for (const width of [688, 1024]) {
  for (const path of ["/", "/about/", "/search/"]) {
    test(`${width} ${path}: top bar with five links and an inline search field, no bottom bar, rail 0x0, 44px targets`, async ({ page }) => {
      await hermetic(page);
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${path}?hfy_flags=shellV2`, { waitUntil: "domcontentloaded" });
      await expect(shell(page)).toBeVisible();
      await expect(shell(page)).toHaveAttribute("data-bp", width >= 1024 ? "expanded" : "medium"); // @io-kit/tokens 0.4.1: bp.wide = 64rem (HFY-R72); HFY styles key only on compact vs not
      await expect(page.locator("#hfy-shell-root nav.io-shell__bar")).toHaveCount(0);
      const links = page.locator("#hfy-shell-root .hfy-bar__links a");
      await expect(links).toHaveCount(5);
      for (const [i, label] of LABELS.entries()) {
        await expect(links.nth(i)).toBeVisible();
        await expect(links.nth(i)).toHaveText(label);
      }
      const field = page.locator("#hfy-shell-root .hfy-bar").getByRole("button", { name: "search", exact: true });
      await expect(field).toBeVisible();
      await expect(field.locator(".hfy-bar__search-hint")).toHaveText("search the family");
      const box = await field.boundingBox();
      expect(box.height).toBe(44);
      expect(box.width).toBeGreaterThan(44);
      const a = await audit(page);
      expect(a.rail, "the kit rail/sidebar is rendered but hidden").toBe("0x0");
      expect(a.small, "targets < 44px").toEqual([]);
      expect(a.smallInputs, "inputs < 16px").toEqual([]);
      expect(a.scrollW).toBeLessThanOrEqual(a.innerW);
    });
  }
}

// --------------------------------------------------------------------------------------------------------- theme tokens
test("1024: shell ground, type, wordmark, nav tint and the gold current-link inset come from the theme", async ({ page }) => {
  await hermetic(page);
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto("/?hfy_flags=shellV2", { waitUntil: "domcontentloaded" });
  await expect(shell(page)).toBeVisible();
  const s = await page.evaluate(async () => {
    await document.fonts.ready;
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    const shellCs = cs("#hfy-shell-root .io-shell");
    const brand = cs("#hfy-shell-root .hfy-bar__brand");
    const bar = cs("#hfy-shell-root .hfy-bar");
    const current = document.querySelector('#hfy-shell-root .hfy-bar__links a[aria-current="page"]');
    const loaded = (family) => [...document.fonts].some((f) => f.family.replace(/["']/g, "") === family && f.status === "loaded");
    return {
      bg: shellCs.backgroundColor, color: shellCs.color, font: shellCs.fontFamily,
      brandFont: brand.fontFamily, brandSize: brand.fontSize, brandWeight: brand.fontWeight, brandText: document.querySelector("#hfy-shell-root .hfy-bar__brand").textContent,
      barBg: bar.backgroundColor, barHeight: document.querySelector("#hfy-shell-root .hfy-bar").getBoundingClientRect().height, barBorder: bar.borderBottomColor,
      current: current && current.textContent, currentColor: current && getComputedStyle(current).color, currentShadow: current && getComputedStyle(current).boxShadow,
      uiLoaded: loaded("Source Sans 3"), displayLoaded: loaded("Libre Caslon Text")
    };
  });
  expect(s.bg).toBe("rgb(20, 18, 16)"); // surface (archive-950)
  expect(s.color).toBe("rgb(250, 246, 238)"); // text (archive-50)
  expect(s.font).toMatch(/^"?Source Sans 3"?,/);
  expect(s.brandText).toBe("Harrison Family");
  expect(s.brandFont).toMatch(/^"?Libre Caslon Text"?,/);
  expect(s.brandSize).toBe("20px");
  expect(s.brandWeight).toBe("400");
  expect(s.barBg).toBe("rgba(88, 182, 231, 0.2)"); // nav.tint
  expect(s.barHeight).toBe(56);
  expect(s.barBorder).toBe("rgb(50, 45, 40)"); // border (archive-800) hairline
  expect(s.current).toBe("home");
  expect(s.currentColor).toBe("rgb(250, 246, 238)"); // text: AAA on the tint (link would be 5.79:1); the gold inset marks it
  expect(ratio(s.currentColor, TINT_ON_SURFACE)).toBeGreaterThanOrEqual(7);
  expect(s.currentShadow).toBe("rgb(255, 193, 7) 0px -3px 0px 0px inset");
  expect(s.uiLoaded, "the self-hosted Source Sans 3 face loaded").toBe(true);
  expect(s.displayLoaded, "the self-hosted Libre Caslon Text face loaded").toBe(true);
});

// ---------------------------------------------------------------------------------------------------------- account slot
for (const width of [375, 1024]) {
  test(`${width}: signed out shows "sign in" (44px, to /auth/login with returnTo); signed in shows the 32px avatar`, async ({ page }) => {
    await hermetic(page, { signedIn: false });
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/about/?hfy_flags=shellV2", { waitUntil: "domcontentloaded" });
    const signIn = page.locator("#hfy-shell-root .hfy-bar").getByRole("link", { name: "sign in", exact: true });
    await expect(signIn).toBeVisible();
    expect(await signIn.getAttribute("href")).toBe(`/auth/login?returnTo=${encodeURIComponent("/about/?hfy_flags=shellV2")}`);
    expect((await signIn.boundingBox()).height).toBe(44);

    const page2 = await page.context().newPage();
    await hermetic(page2, { signedIn: true });
    await page2.setViewportSize({ width, height: 800 });
    await page2.goto("/about/?hfy_flags=shellV2", { waitUntil: "domcontentloaded" });
    const avatar = page2.getByRole("button", { name: `you're signed in as ${ME.label}` });
    await expect(avatar).toBeVisible();
    const hit = await avatar.boundingBox();
    expect(hit.width).toBeGreaterThanOrEqual(44);
    expect(hit.height).toBeGreaterThanOrEqual(44);
    const disc = await avatar.locator(".hfy-avatar").evaluate((e) => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return { w: r.width, h: r.height, bg: c.backgroundColor, fg: c.color, text: e.textContent }; });
    expect(disc).toEqual({ w: 32, h: 32, bg: "rgb(88, 182, 231)", fg: "rgb(20, 18, 16)", text: "M" });
    await expect(page2.locator("#hfy-shell-root .hfy-bar").getByRole("link", { name: "sign in" })).toHaveCount(0);
    await page2.close();
  });
}

// /about/ has the hidden legacy navbar (auth-v2.js wires its sign-out link, which the sheet proxies); /posts/ has none (fallback).
for (const path of ["/about/", "/posts/"]) test(`${path}: the account sheet links your page and notifications, and 'sign out' ends the edge session`, async ({ page }) => {
  const calls = await hermetic(page, { signedIn: true });
  await page.goto(`${path}?hfy_flags=shellV2`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: `you're signed in as ${ME.label}` }).click();
  const sheet = page.getByRole("dialog", { name: ME.label });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("link", { name: "your page" })).toHaveAttribute("href", `/person/?id=${ME.sub}`);
  await expect(sheet.getByRole("link", { name: "notifications" })).toHaveAttribute("href", "/me/notifications/");
  const rows = await sheet.locator(".hfy-account__item").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  for (const h of rows) expect(h).toBeGreaterThanOrEqual(44);
  await sheet.getByRole("button", { name: "sign out" }).click();
  await page.waitForURL("**/logged-out/");
  expect(calls).toContain("POST /auth/logout");
});

// ----------------------------------------------------------------------------------------------------- navMe (HFY-TSK-091)
// With navMe the own page is "me", "family" leaves the bar (until familyViz), and a gear before the avatar opens the /me/ settings hub.
const GOLD = "rgb(255, 193, 7)"; // accent.secondary (gold-400)
const TEXT = "rgb(250, 246, 238)"; // text (archive-50)
const gearOf = (page) => page.locator("#hfy-shell-root .hfy-bar__end a.hfy-gear");

for (const path of PAGES) {
  for (const signedIn of [true, false]) {
    test(`375 ${path} navMe ${signedIn ? "signed in" : "signed out"}: four bottom cells (about 94 x 56), the gear ${signedIn ? "before the avatar" : "absent"}, 44px targets, 16px inputs, no h-scroll, axe clean`, async ({ page }) => {
      await hermetic(page, { signedIn });
      await page.goto(`${path}?hfy_flags=shellV2,navMe`, { waitUntil: "domcontentloaded" });
      await expect(shell(page)).toHaveAttribute("data-bp", "compact");
      await expect(page.locator(`#hfy-shell-root [data-hfy-account="${signedIn ? "signed-in" : "signed-out"}"]`)).toBeVisible();
      const items = page.locator("#hfy-shell-root nav.io-shell__bar .io-nav__item--bar");
      const labels = labelsFor({ navMe: true });
      await expect(items).toHaveCount(4);
      for (const [i, label] of labels.entries()) await expect(items.nth(i)).toHaveAccessibleName(label);
      const cells = await items.evaluateAll((els) => els.map((e) => {
        const r = e.getBoundingClientRect();
        const icon = e.querySelector(".io-nav__icon").getBoundingClientRect();
        return { w: r.width, h: r.height, icon: `${icon.width}x${icon.height}` };
      }));
      for (const c of cells) {
        expect(Math.abs(c.w - 375 / 4), `cell width ${c.w}`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(c.h - 56), `cell height ${c.h}`).toBeLessThanOrEqual(0.5);
        expect(c.icon).toBe("24x24");
      }
      await expect(page.locator('#hfy-shell-root [data-io-nav-item="family"]')).toHaveCount(0);
      if (signedIn) {
        const gear = gearOf(page);
        await expect(gear).toBeVisible();
        await expect(gear).toHaveAttribute("href", "/me/");
        await expect(gear).toHaveAccessibleName("settings");
        const box = await gear.boundingBox();
        expect([box.width, box.height]).toEqual([44, 44]);
        // .hfy-bar__end: the gear, then the account control
        const order = await page.locator("#hfy-shell-root .hfy-bar__end > *").evaluateAll((els) => els.map((e) => (e.hasAttribute("data-hfy-gear") ? "gear" : e.getAttribute("data-hfy-account"))));
        expect(order).toEqual(["gear", "signed-in"]);
      } else {
        await expect(gearOf(page)).toHaveCount(0);
      }
      const a = await audit(page);
      expect(a.small, "targets < 44px").toEqual([]);
      expect(a.smallInputs, "inputs < 16px").toEqual([]);
      expect(a.scrollW).toBeLessThanOrEqual(a.innerW);
      expect(await axeViolations(page)).toEqual([]);
    });
  }
}

// Until the session names the member there is no gear and "me" is the /private/ redirect: while it is pending, and when /auth/session
// is unreachable (the bar then shows "sign in", as the /me/ hub does).
test("375 navMe, session pending: no gear and 'me' is /private/; once the session names the member, the gear and the own page", async ({ page }) => {
  await hermetic(page, { signedIn: true });
  let release;
  const hold = new Promise((r) => { release = r; });
  await page.route("**/auth/session", async (r) => { await hold; return r.fulfill({ json: { authenticated: true, sub: ME.sub, grampsId: ME.sub, label: ME.label } }); });
  await page.goto("/about/?hfy_flags=shellV2,navMe", { waitUntil: "domcontentloaded" });
  const me = page.locator('#hfy-shell-root [data-io-nav-item="me"]');
  await expect(me).toHaveAttribute("href", "/private/");
  await expect(page.locator('#hfy-shell-root [data-hfy-account="loading"]')).toBeAttached();
  await expect(gearOf(page)).toHaveCount(0);
  release();
  await expect(gearOf(page)).toBeVisible();
  await expect(me).toHaveAttribute("href", `/person/?id=${ME.sub}`);
  await expect(page.locator('#hfy-shell-root [data-hfy-account="signed-in"]')).toBeVisible();
});

test("375 navMe, /auth/session unreachable: no gear, 'me' stays /private/, and the bar shows 'sign in'", async ({ page }) => {
  await hermetic(page, { signedIn: true });
  await page.route("**/auth/session", (r) => r.fulfill({ status: 503, body: "down" }));
  await page.goto("/about/?hfy_flags=shellV2,navMe", { waitUntil: "domcontentloaded" });
  await expect(page.locator('#hfy-shell-root [data-hfy-account="signed-out"]')).toBeVisible();
  await expect(page.locator("#hfy-shell-root nav.io-shell__bar .io-nav__item--bar")).toHaveCount(4);
  await expect(page.locator('#hfy-shell-root [data-io-nav-item="me"]')).toHaveAttribute("href", "/private/");
  await expect(gearOf(page)).toHaveCount(0);
});

test("375 navMe + familyViz: five cells again, family is the tree (never /family/), me is the own page", async ({ page }) => {
  await hermetic(page, { signedIn: true });
  await page.goto("/about/?hfy_flags=shellV2,navMe,familyViz", { waitUntil: "domcontentloaded" });
  await expect(page.locator('#hfy-shell-root [data-hfy-account="signed-in"]')).toBeVisible();
  const items = page.locator("#hfy-shell-root nav.io-shell__bar .io-nav__item--bar");
  await expect(items).toHaveCount(5);
  for (const [i, label] of labelsFor({ navMe: true, familyViz: true }).entries()) await expect(items.nth(i)).toHaveAccessibleName(label);
  await expect(page.locator('#hfy-shell-root [data-io-nav-item="family"]')).toHaveAttribute("href", "/tree/");
  await expect(page.locator('#hfy-shell-root [data-io-nav-item="me"]')).toHaveAttribute("href", `/person/?id=${ME.sub}`);
  for (const w of await items.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width))) expect(Math.abs(w - 75)).toBeLessThanOrEqual(0.5);
});

for (const width of [688, 1024]) {
  test(`${width} navMe: top bar with four links, the gear at the right end before the avatar, 44px targets`, async ({ page }) => {
    await hermetic(page, { signedIn: true });
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/about/?hfy_flags=shellV2,navMe", { waitUntil: "domcontentloaded" });
    const avatar = page.locator('#hfy-shell-root [data-hfy-account="signed-in"]');
    await expect(avatar).toBeVisible();
    const links = page.locator("#hfy-shell-root .hfy-bar__links a");
    await expect(links).toHaveText(labelsFor({ navMe: true }));
    await expect(links.filter({ hasText: /^me$/ })).toHaveAttribute("href", `/person/?id=${ME.sub}`);
    const g = await gearOf(page).boundingBox();
    const av = await avatar.boundingBox();
    const bar = await page.locator("#hfy-shell-root .hfy-bar").boundingBox();
    expect([g.width, g.height]).toEqual([44, 44]);
    expect(g.x + g.width).toBeLessThanOrEqual(av.x);
    expect(bar.x + bar.width - (av.x + av.width)).toBeLessThanOrEqual(64); // the end of the bar, inside the page gutter
    const a = await audit(page);
    expect(a.small, "targets < 44px").toEqual([]);
    expect(a.scrollW).toBeLessThanOrEqual(a.innerW);
  });
}

test("navMe: the gear's icon is a currentColor mask, `text` elsewhere and gold on /me/ and its sub-paths (aria-current)", async ({ page }) => {
  await hermetic(page, { signedIn: true });
  const look = () => gearOf(page).evaluate((e) => {
    const icon = getComputedStyle(e.querySelector(".hfy-gear__icon"));
    return { current: e.getAttribute("aria-current"), color: getComputedStyle(e).color, fill: icon.backgroundColor, mask: (icon.maskImage || icon.webkitMaskImage || "").startsWith('url("data:image/svg+xml') };
  });
  await page.goto("/about/?hfy_flags=shellV2,navMe", { waitUntil: "domcontentloaded" });
  await expect(gearOf(page)).toBeVisible();
  expect(await look()).toEqual({ current: null, color: TEXT, fill: TEXT, mask: true });
  for (const path of ["/me/", "/me/notifications/"]) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(gearOf(page)).toBeVisible();
    expect(await look()).toEqual({ current: "page", color: GOLD, fill: GOLD, mask: true });
  }
});

test("navMe: the account sheet reads 'your page', 'settings', 'sign out' (the notifications row moved into the hub)", async ({ page }) => {
  await hermetic(page, { signedIn: true });
  await page.goto("/about/?hfy_flags=shellV2,navMe", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: `you're signed in as ${ME.label}` }).click();
  const sheet = page.getByRole("dialog", { name: ME.label });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".hfy-account__item")).toHaveText(["your page", "settings", "sign out"]);
  await expect(sheet.getByRole("link", { name: "your page" })).toHaveAttribute("href", `/person/?id=${ME.sub}`);
  await expect(sheet.getByRole("link", { name: "settings" })).toHaveAttribute("href", "/me/");
  await expect(sheet.getByRole("link", { name: "notifications" })).toHaveCount(0);
  for (const h of await sheet.locator(".hfy-account__item").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
});

test("navMe off (the build flags): no gear, and the sheet keeps 'notifications'", async ({ page }) => {
  await hermetic(page, { signedIn: true });
  await page.goto("/about/?hfy_flags=shellV2", { waitUntil: "domcontentloaded" });
  await expect(page.locator('#hfy-shell-root [data-hfy-account="signed-in"]')).toBeVisible();
  await expect(gearOf(page)).toHaveCount(0);
  await page.getByRole("button", { name: `you're signed in as ${ME.label}` }).click();
  await expect(page.getByRole("dialog", { name: ME.label }).locator(".hfy-account__item")).toHaveText(["your page", "notifications", "sign out"]);
});

// ------------------------------------------------------------------------------------------------- scroller and modals
test("the scroller is a named region (the page's <main> is the only main) and a top-level Bootstrap .modal stays in <body>", async ({ page }) => {
  await hermetic(page);
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const m = document.createElement("div");
      m.className = "modal fade";
      m.id = "hfy-test-modal";
      m.setAttribute("tabindex", "-1");
      document.body.appendChild(m);
    });
  });
  await page.goto("/about/?hfy_flags=shellV2", { waitUntil: "domcontentloaded" });
  await expect(shell(page)).toBeVisible();
  await expect(page.locator(".hfy-content main")).toBeAttached();
  const s = await page.evaluate(() => ({
    modalParent: document.getElementById("hfy-test-modal").parentElement === document.body,
    mains: document.querySelectorAll("main").length,
    scrollerTag: document.querySelector("[data-io-scroller]").tagName,
    pageMainInContent: Boolean(document.querySelector(".hfy-content > main"))
  }));
  expect(s.modalParent, "the .modal stays a direct child of <body>").toBe(true);
  expect(s.mains).toBe(1);
  expect(s.scrollerTag).toBe("DIV");
  expect(s.pageMainInContent).toBe(true);
  await expect(page.getByRole("region", { name: "page content" })).toBeAttached();
  await expect(page.getByRole("main")).toHaveCount(1);
});

// ------------------------------------------------------------------------------------------------------------- pre-mount
test("pre-mount (375): the static theme hides the navbar and paints both bar strips until KitShell mounts", async ({ page }) => {
  await hermetic(page);
  await page.addInitScript(() => { try { localStorage.setItem("hfy:shell-hint", "1"); } catch { /* storage blocked */ } });
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route("**/js/islands/shell.js*", async (r) => { await held; await r.continue(); });
  await page.goto("/about/?hfy_flags=shellV2", { waitUntil: "domcontentloaded" });
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("hfy-shell-v2"))).toBe(true);
  await expect(page.locator("nav.navbar-hf")).toBeHidden();
  const strip = (pseudo) => page.evaluate((p) => { const s = getComputedStyle(document.body, p); return [s.position, s.height, s.backgroundColor]; }, pseudo);
  expect(await strip("::before")).toEqual(["fixed", "56px", "rgba(88, 182, 231, 0.2)"]);
  expect(await strip("::after")).toEqual(["fixed", "56px", "rgba(88, 182, 231, 0.2)"]);
  release();
  await expect(shell(page)).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body, "::before").content)).toBe("none");
});

// ------------------------------------------------------------------------------------------------------ flags and no-JS
test("flag off (-shellV2): old navbar, no shell, nothing injected", async ({ page }) => {
  await hermetic(page);
  await page.goto("/?hfy_flags=-shellV2");
  await page.waitForTimeout(500);
  await expect(page.locator("nav.navbar-hf")).toBeVisible();
  expect(await page.locator("#hfy-shell-root").count()).toBe(0);
  expect(await page.locator("link[rel=manifest]").count()).toBe(0);
});

test("HFY-R58: override persists in sessionStorage hfy:flags (never localStorage) and empty value clears it", async ({ page }) => {
  await hermetic(page);
  await page.goto("/?hfy_flags=-shellV2");
  expect(await page.evaluate(() => sessionStorage.getItem("hfy:flags"))).toBe("-shellV2");
  expect(await page.evaluate(() => localStorage.getItem("hfy:flags"))).toBeNull();
  await page.goto("/about/");
  await page.waitForTimeout(400);
  await expect(page.locator("nav.navbar-hf")).toBeVisible();
  expect(await page.locator("#hfy-shell-root").count()).toBe(0);
  await page.goto("/?hfy_flags=");
  expect(await page.evaluate(() => sessionStorage.getItem("hfy:flags"))).toBeNull();
  await expect(shell(page)).toBeVisible(); // back to the build flags (shellV2 on)
  await expect(page.locator("[data-hfy-flag-banner]")).toHaveCount(0);
});

test("AC3: static nav links present without JS", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, javaScriptEnabled: false, viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  await page.goto("/?hfy_flags=shellV2");
  await expect(page.locator('nav.navbar-hf a[href="/about/"]')).toHaveCount(1);
  await ctx.close();
});

test("the shell's button reset never squares an island's pill (notification switch, comment reaction)", async ({ page }) => {
  await hermetic(page, { signedIn: true });
  await page.goto("/me/notifications/?hfy_flags=shellV2,notifyV2", { waitUntil: "domcontentloaded" });
  const sw = page.locator(".hfy-notify .iok-notify-switch").first();
  await expect(sw).toBeVisible();
  expect(await sw.evaluate((e) => getComputedStyle(e).borderTopLeftRadius)).toBe("999px");
  // a kit-owned shell button keeps the reset (8px)
  const sheetClose = await page.evaluate(() => {
    const b = document.createElement("button");
    b.className = "hfy-probe";
    document.querySelector("#hfy-shell-root .io-shell").append(b);
    const r = getComputedStyle(b).borderTopLeftRadius;
    b.remove();
    return r;
  });
  expect(sheetClose).toBe("8px");
});

// ------------------------------------------------------------------------------------------- the ordered bar slots (HFY-TSK-138)
// .hfy-bar__end is bell, chat, gear, account (lib/bar-slots.js). The bell and chat slots stay empty until their islands fill them; these
// stub fillers stand in for hfy-inbox-ui and hfy-chat-island, and are registered in the opposite order to prove the shell owns the order.
const slotOrder = (page) => page.locator("#hfy-shell-root .hfy-bar__end > [data-slot]").evaluateAll((els) => els.map((e) => e.getAttribute("data-slot")));
const stub = (name) => `(window.__unfill ||= []).push(window.HFYBarSlots.fill(${JSON.stringify(name)}, (host) => { const b = document.createElement("button"); b.type = "button"; b.setAttribute("aria-label", "stub ${name}"); b.style.width = "44px"; b.style.height = "44px"; host.append(b); return () => b.remove(); }));`;

for (const navMe of [true, false]) {
  test(`375 slots, navMe ${navMe ? "on" : "off"}: empty bell and chat render nothing; stub fillers land in the order bell, chat, gear, account; the bar does not overflow`, async ({ page }) => {
    await hermetic(page, { signedIn: true });
    await page.goto(`/about/?hfy_flags=shellV2${navMe ? ",navMe" : ""}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator('#hfy-shell-root [data-hfy-account="signed-in"]')).toBeVisible();
    if (navMe) await expect(gearOf(page)).toBeVisible();
    const own = navMe ? ["gear", "account"] : ["account"];
    expect(await slotOrder(page)).toEqual(own); // empty slots: no element at all
    const emptyW = await page.locator("#hfy-shell-root .hfy-bar__end").evaluate((e) => e.getBoundingClientRect().width);
    await page.evaluate(stub("chat"));
    await page.evaluate(stub("bell"));
    await expect(page.locator('#hfy-shell-root [data-slot="bell"] button')).toBeVisible();
    expect(await slotOrder(page)).toEqual(["bell", "chat", ...own]);
    const a = await audit(page);
    expect(a.small, "targets < 44px").toEqual([]);
    expect(a.scrollW).toBeLessThanOrEqual(a.innerW);
    const filledW = await page.locator("#hfy-shell-root .hfy-bar__end").evaluate((e) => e.getBoundingClientRect().width);
    expect(filledW).toBeGreaterThan(emptyW);
    // withdrawing the fills restores today's bar: no host element is left behind
    await page.evaluate(() => { (window.__unfill || []).forEach((f) => f()); });
    expect(await slotOrder(page)).toEqual(own);
  });
}
