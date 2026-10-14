// HFY-TSK-069: regression tests for the D-11 after-state audit fixes (items 2-5, follow-ups 2, 4, 7). Synthetic data; /auth and /api are
// stubbed by route interception. Item 1 (auth page stylesheet) is checked by scripts/infra/test/run.sh; item 6 (login continuity) lives in
// flags-fallback.spec.mjs and tests/client.
import { test, expect } from "@playwright/test";
import { catalogFor } from "../src/lib/notify-catalog.js";

// The toggles a member sees: every catalog type except the moderators' group (/api/me reports no admin here).
const MEMBER_TYPES = Object.keys(catalogFor({ admin: false }).types).length;

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const MANIFEST = { people: [
  { grampsId: "I0001", displayName: "Mary Quillfeather", isLiving: false, lifespanSummary: "1901 – 1980", primaryPhoto: null },
  { grampsId: "I0003", displayName: "Ada Brambleton", isLiving: false, lifespanSummary: "1850 – 1920", primaryPhoto: null }
] };
const INDEX = { documents: MANIFEST.people.map((p) => ({ grampsId: p.grampsId, searchText: p.displayName.toLowerCase() })) };

async function hermetic(page, { signedIn = false, legacyToken = false } = {}) {
  const api = [];
  if (legacyToken) await page.addInitScript(() => { try { sessionStorage.setItem("HFY_GATEWAY_SESSION_V1", JSON.stringify({ token: "test-token", grampsId: null, expiresAt: Date.now() + 3600e3, verifiedAt: Date.now() })); } catch {} });
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/auth/session", (r) => r.fulfill({ json: signedIn ? { authenticated: true, sub: "I0001", grampsId: "I0001", label: "Test" } : { authenticated: false } }));
  await page.route("**/api/**", (r) => {
    const u = new URL(r.request().url());
    api.push(`${r.request().method()} ${u.pathname}`);
    if (u.pathname.endsWith("/preferences")) return r.fulfill({ json: { enabled: true, types: {}, extra: {} } });
    if (u.pathname.endsWith("/vapid-public-key")) return r.fulfill({ json: { public_key: "AAAA" } });
    if (u.pathname === "/api/posts") return r.fulfill({ json: { items: [], cursor: null } });
    return signedIn ? r.fulfill({ json: {} }) : r.fulfill({ status: 401, json: { error: "unauthenticated" } });
  });
  await page.route("**/person/index.json", (r) => r.fulfill({ json: MANIFEST }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: INDEX }));
  return api;
}

// WCAG contrast of an element's text against what is really painted behind it (backgrounds composited up the ancestor chain, opacity applied).
const CONTRAST = () => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (t, b) => { const a = t.a + b.a * (1 - t.a); return a === 0 ? { r: 0, g: 0, b: 0, a: 0 } : { r: (t.r * t.a + b.r * b.a * (1 - t.a)) / a, g: (t.g * t.a + b.g * b.a * (1 - t.a)) / a, b: (t.b * t.a + b.b * b.a * (1 - t.a)) / a, a }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  return (el) => {
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    const chain = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) chain.push(n);
    for (const n of chain.reverse()) { const bg = parse(getComputedStyle(n).backgroundColor); if (bg.a > 0) acc = over(bg, acc); }
    let op = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) op *= parseFloat(getComputedStyle(n).opacity);
    const fg0 = parse(getComputedStyle(el).color);
    const fg = over({ ...fg0, a: fg0.a * op }, acc);
    const x = lum(fg), y = lum(acc);
    return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100;
  };
};
const contrastOf = (page, selector) => page.evaluate(([sel, src]) => {
  const ratio = eval(`(${src})`)();
  return [...document.querySelectorAll(sel)].filter((e) => e.getBoundingClientRect().width > 0).map((e) => ({ text: (e.textContent || "").trim().slice(0, 24), ratio: ratio(e) }));
}, [selector, CONTRAST.toString()]);

// ---------------------------------------------------------------- item 2: notification radio groups wrap/stack, never clip
for (const width of [375, 414, 480, 600, 1280]) {
  test(`D-11 item 2: /me/notifications at ${width}px, no radio group is clipped or squeezed`, async ({ page }) => {
    await hermetic(page, { signedIn: true });
    await page.setViewportSize({ width, height: 812 });
    await page.goto("/me/notifications/?hfy_flags=notifyV2", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".iok-notify-seg").first()).toBeVisible();
    const segs = await page.evaluate(() => [...document.querySelectorAll(".iok-notify-seg")].map((s) => {
      const r = s.getBoundingClientRect();
      const li = s.closest("li").getBoundingClientRect();
      return {
        left: r.left, right: r.right, vw: innerWidth, liRight: li.right, w: r.width, clientW: s.clientWidth, scrollW: s.scrollWidth,
        buttons: [...s.children].map((b) => { const br = b.getBoundingClientRect(); return { left: br.left, right: br.right, text: b.textContent.trim(), clipped: b.scrollWidth > b.clientWidth + 1 }; }),
        below: r.top >= s.closest("li").firstElementChild.getBoundingClientRect().bottom - 1,
      };
    }));
    expect(segs.length, "one detail group per catalog type").toBe(MEMBER_TYPES);
    for (const s of segs) {
      expect(s.scrollW, "group content is not wider than the group").toBeLessThanOrEqual(s.clientW);
      expect(s.left).toBeGreaterThanOrEqual(0);
      expect(s.right, "inside the viewport").toBeLessThanOrEqual(s.vw);
      expect(s.right, "inside its row").toBeLessThanOrEqual(s.liRight + 0.5);
      for (const b of s.buttons) { expect(b.clipped, b.text).toBe(false); expect(b.right).toBeLessThanOrEqual(s.right + 0.5); }
      if (width <= 430) { expect(s.below, "stacked under the text on phones").toBe(true); expect(s.w).toBeGreaterThanOrEqual(s.liRight - s.left - 1); }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

// ---------------------------------------------------------------- item 3: notification contrast (AA, real painted background)
for (const flags of ["notifyV2,shellV2", "notifyV2"]) test(`D-11 item 3: /me/notifications (${flags}) text and the selected radio meet 4.5:1`, async ({ page }) => {
  await hermetic(page, { signedIn: true });
  await page.goto(`/me/notifications/?hfy_flags=${flags}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".iok-notify-seg").first()).toBeVisible();
  for (const sel of [".iok-notify-desc", ".iok-notify-seg button[aria-checked=true]", ".iok-notify-seg button[aria-checked=false]", ".iok-notify-group > h4", ".iok-notify-status", ".iok-notify-row label, .iok-notify-row > div > span:first-child"]) {
    const rows = await contrastOf(page, sel);
    for (const r of rows) expect(r.ratio, `${sel} "${r.text}"`).toBeGreaterThanOrEqual(4.5);
  }
  expect((await contrastOf(page, ".iok-notify-desc")).length).toBe(MEMBER_TYPES);
});

// ---------------------------------------------------------------- item 4 + follow-up 7: /search contrast, install hint at the top
test("D-11 item 4: /search count, title, rows and the empty state meet 4.5:1 on the dark shell", async ({ page }) => {
  await hermetic(page, { legacyToken: true });
  await page.goto("/search/?q=Quillfeather&hfy_flags=searchV2", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#hfy-search-v2").getByRole("link", { name: /Mary Quillfeather/ })).toBeVisible();
  // (the "hide toggles" control is gone: the DS pass renders the search island with controlsToggle={false})
  for (const sel of [".io-search-header__count", ".io-search-header__title", ".hfy-search__name", ".hfy-search__meta"]) {
    const rows = await contrastOf(page, sel);
    expect(rows.length, sel).toBeGreaterThan(0);
    for (const r of rows) expect(r.ratio, `${sel} "${r.text}"`).toBeGreaterThanOrEqual(4.5);
  }
  await page.goto("/search/?q=zzzznomatch&hfy_flags=searchV2", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".io-search-zero__title")).toBeVisible();
  for (const sel of [".io-search-zero__title", ".io-search-zero__text", ".io-search-header__count"]) {
    for (const r of await contrastOf(page, sel)) expect(r.ratio, `${sel} "${r.text}"`).toBeGreaterThanOrEqual(4.5);
  }
});

test("D-11 follow-up 7: the iOS install hint is the first thing in the scroller on /search/ (not below the search controls)", async ({ browser }) => {
  const ctx = await browser.newContext({ userAgent: IPHONE_UA, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await hermetic(page, { legacyToken: true });
  await page.goto("/search/?q=Quillfeather&hfy_flags=searchV2", { waitUntil: "domcontentloaded" });
  const hint = page.locator("[data-hfy-install]");
  await expect(hint).toContainText("add to home screen");
  await expect(page.locator("#hfy-search-v2").getByRole("link", { name: /Mary Quillfeather/ })).toBeVisible();
  const order = await page.evaluate(() => {
    const main = document.querySelector("[data-io-scroller]");
    const kids = [...main.children];
    const search = document.getElementById("hfy-search-v2");
    return { hintIndex: kids.findIndex((k) => k.hasAttribute("data-hfy-install")), searchInside: main.querySelector(".hfy-content").contains(search), hintBottom: main.querySelector("[data-hfy-install]").getBoundingClientRect().bottom, searchTop: search.getBoundingClientRect().top };
  });
  expect(order.hintIndex).toBe(0);
  expect(order.searchInside, "the search host lives in the page content").toBe(true);
  expect(order.hintBottom).toBeLessThanOrEqual(order.searchTop + 0.5);
  await ctx.close();
});

// ---------------------------------------------------------------- item 5: the shell scroller is a focusable, named region
// DS pass: the scroller is a role=region <div> named "page content", so the page's own Eleventy <main> is the only main landmark.
test("D-11 item 5: [data-io-scroller] is a keyboard-focusable named region and scrolls from the keyboard", async ({ page }) => {
  await hermetic(page);
  await page.goto("/about/?hfy_flags=shellV2", { waitUntil: "domcontentloaded" });
  const scroller = page.locator("[data-io-scroller]");
  await expect(scroller).toHaveAttribute("tabindex", "0");
  await expect(scroller).toHaveAttribute("role", "region");
  await expect(scroller).toHaveAttribute("aria-label", "page content");
  await expect(page.getByRole("region", { name: "page content" })).toBeAttached();
  await expect(page.getByRole("main")).toHaveCount(1);
  await page.evaluate(() => document.querySelector("[data-io-scroller]").focus());
  expect(await page.evaluate(() => document.activeElement === document.querySelector("[data-io-scroller]"))).toBe(true);
  expect(await page.evaluate(() => { const s = document.querySelector("[data-io-scroller]"); return s.scrollHeight > s.clientHeight; }), "the page overflows the scroller").toBe(true);
  await page.keyboard.press("PageDown");
  await expect.poll(() => page.evaluate(() => document.querySelector("[data-io-scroller]").scrollTop)).toBeGreaterThan(0);
  // keyboard focus shows a ring (inset outline) on the scroller
  await page.evaluate(() => { document.body.focus(); document.querySelector("[data-io-scroller]").blur(); });
  await page.keyboard.press("Tab");
  const ring = await page.evaluate(() => { const s = document.querySelector("[data-io-scroller]"); const cs = getComputedStyle(s); return { focused: document.activeElement === s, width: cs.outlineWidth, style: cs.outlineStyle }; });
  if (ring.focused) { expect(ring.style).toBe("solid"); expect(parseFloat(ring.width)).toBeGreaterThanOrEqual(2); }
});

// ---------------------------------------------------------------- follow-up 2: no certain-401 requests while signed out
test("D-11 follow-up 2: authV2 signed out: /posts/ and the home timeline send no /api/posts request and log no 401", async ({ page }) => {
  const api = await hermetic(page, { signedIn: false });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("/posts/?hfy_flags=authV2,postsV2", { waitUntil: "domcontentloaded" });
  // the living-person gate: neutral (not a danger banner, not role=alert), one line and one 44px "sign in"
  const gate = page.locator("[data-hfy-gate]");
  await expect(gate).toContainText("this page is family-only. sign in to see it.");
  await expect(gate).toHaveAttribute("role", "status");
  expect((await gate.getByRole("link", { name: "sign in" }).boundingBox()).height).toBeGreaterThanOrEqual(44);
  await expect(page.locator("[data-hfy-banner]")).toHaveCount(0);
  await page.goto("/?hfy_flags=authV2,postsV2", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  // the public home page shows no gate at all: the timeline renders nothing signed out (the hero offers sign in)
  await expect(page.locator("[data-hfy-timeline], [data-hfy-gate], [data-hfy-banner], #hfy-timeline [role=alert]")).toHaveCount(0);
  expect(api.filter((a) => a.includes("/api/posts"))).toEqual([]);
  expect(errors.filter((e) => /401|Unauthorized/.test(e))).toEqual([]);
});

test("D-11 follow-up 2: authV2 signed out: /me/notifications sends no preferences request and logs no 401", async ({ page }) => {
  const api = await hermetic(page, { signedIn: false });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("/me/notifications/?hfy_flags=authV2,notifyV2", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".hfy-notify")).toBeVisible();
  await page.waitForTimeout(800);
  expect(api.filter((a) => a.includes("/api/notifications"))).toEqual([]);
  expect(errors.filter((e) => /401|Unauthorized/.test(e))).toEqual([]);
});

test("D-11 follow-up 2: authV2 signed in, and authV2 off: the same requests ARE sent (no behaviour change)", async ({ page }) => {
  const api = await hermetic(page, { signedIn: true });
  await page.goto("/me/notifications/?hfy_flags=authV2,notifyV2", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".hfy-notify")).toBeVisible();
  await expect.poll(() => api.filter((a) => a.endsWith("/api/notifications/preferences")).length).toBeGreaterThan(0);
  await page.goto("/posts/?hfy_flags=authV2,postsV2", { waitUntil: "domcontentloaded" });
  await expect.poll(() => api.filter((a) => a.endsWith("/api/posts")).length).toBeGreaterThan(0);
  // authV2 off: even with a signed-out edge probe the legacy request is sent unchanged
  const off = await page.context().newPage();
  const offApi = await hermetic(off, { signedIn: false });
  await off.goto("/posts/?hfy_flags=-authV2,postsV2", { waitUntil: "domcontentloaded" });
  await expect.poll(() => offApi.filter((a) => a.endsWith("/api/posts")).length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------- follow-up 4 (HFY-TSK-317): no Google Identity Services at all
test("D-11 follow-up 4 / HFY-TSK-317: no page requests the Google client or /api/check-allowed, so there is no One Tap to prompt", async ({ page }) => {
  await hermetic(page, { signedIn: false });
  const hits = [];
  page.on("request", (r) => { if (/accounts\.google\.com|\/api\/check-allowed/.test(r.url())) hits.push(r.url()); });
  for (const path of ["/?hfy_flags=authV2,shellV2", "/?hfy_flags=-authV2", "/about/", "/search/?hfy_flags=searchV2", "/person/?id=I0001"]) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(400);
  }
  expect(hits).toEqual([]);
});

// ---------------------------------------------------------------- item 6 (searchV2 variant), after HFY-TSK-317
test("D-11 item 6 / HFY-TSK-317: the search island's corpus refused with 401 shows the signed-out line; there is no 8 s wait and no /family-login/ detour", async ({ page }) => {
  await hermetic(page, { signedIn: false });
  await page.route("**/person/index.json", (r) => r.fulfill({ status: 401, json: {} }));
  await page.route("**/auth/login**", (r) => r.fulfill({ contentType: "text/html", body: "<h1>edge login</h1>" }));
  // authV2 off for this tab: dataFetch is a plain fetch, so the 401 reaches the corpus, which shows its banner
  await page.goto("/?hfy_flags=searchV2,-authV2");
  await page.goto("/search/?query=Harrison#top");
  await expect(page.locator("#hfy-search-v2")).toContainText("family-only", { timeout: 10_000 });
  expect(new URL(page.url()).pathname).toBe("/search/");
});
