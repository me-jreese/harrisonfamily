// HFY design-system pass (islands): the islands render in the approved harrisonfamily look (ds/components/{Posts,Comments,
// Notifications,Search}). Computed colours are the dark-theme token values from @io-kit/tokens 0.4.0 harrisonfamily theme.css.
// Synthetic data only (fixtures/islands-look.json); /auth/session, /api/* and the data JSON are stubbed by route interception.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const FX = JSON.parse(readFileSync(new URL("./fixtures/islands-look.json", import.meta.url), "utf8"));
const RGB = {
  surface: "rgb(20, 18, 16)", // archive-950
  raised: "rgb(33, 30, 27)", // archive-900
  sunken: "rgb(13, 12, 10)",
  text: "rgb(250, 246, 238)", // archive-50
  dim: "rgb(205, 191, 166)", // archive-300
  accent: "rgb(88, 182, 231)", // columbia-400
  accentText: "rgb(20, 18, 16)",
  focus: "rgb(255, 193, 7)", // gold-400
  pill: "rgb(21, 74, 107)", // columbia-800
  borderStrong: "rgb(133, 118, 102)", // archive-500
  transparent: "rgba(0, 0, 0, 0)",
};
const FLAGS = "hfy_flags=shellV2,postsV2,personV2,searchV2,notifyV2";
const ISLANDS = "[data-hfy-timeline], [data-hfy-posts], #hfy-my-posts, [data-hfy-comments], #hfy-search-v2, .hfy-notify";
const at = (min) => new Date(Date.now() - min * 60e3).toISOString();

async function stub(page, { delayCorpusMs = 0 } = {}) {
  const posts = FX.posts.map(({ agoMin, ...p }) => ({ ...p, created_at: at(agoMin), updated_at: at(agoMin) }));
  const comments = FX.comments.map(({ agoMin, ...c }) => ({ ...c, threadId: "x", created_at: at(agoMin) }));
  const reactions = Object.fromEntries(Object.entries(FX.reactions).map(([k, v]) => [k, v.map((r) => ({ ...r, created_at: at(60) }))]));
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: FX.me.id, grampsId: FX.me.id, label: FX.me.label } }));
  await page.route(/\/person\/I\d+\.json/, (r) => r.fulfill({ json: FX.person }));
  await page.route("**/person/index.json", async (r) => { if (delayCorpusMs) await new Promise((x) => setTimeout(x, delayCorpusMs)); return r.fulfill({ json: FX.manifest }); });
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: FX.manifest.people.map((p) => ({ grampsId: p.grampsId, searchText: p.displayName.toLowerCase() })) } }));
  await page.route(/\/api\/posts(\/[^/?]+)?(\?.*)?$/, (r) => {
    const u = new URL(r.request().url());
    const id = u.pathname.split("/")[3];
    if (id) return r.fulfill({ json: posts.find((p) => p.id === id) ?? posts[0] });
    const subject = u.searchParams.get("subject");
    return r.fulfill({ json: { items: posts.filter((p) => !subject || p.subject === subject), cursor: null } });
  });
  await page.route("**/api/comments**", (r) => r.fulfill({ json: { thread: { id: "x", topic: "comments", comments, reactions } } }));
  await page.route("**/api/notifications/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path.endsWith("/vapid-public-key")) return r.fulfill({ json: { public_key: "AAAA" } });
    if (path.endsWith("/preferences")) return r.fulfill({ json: FX.preferences });
    return r.fulfill({ json: {} });
  });
}

// Every visible text node inside the islands: its font size and the first family of its computed stack.
const textAudit = (page) => page.evaluate((sel) => {
  const small = [];
  const fonts = [];
  let seen = 0;
  const brand = ["Source Sans 3", "Libre Caslon Text", "Source Code Pro"];
  for (const root of document.querySelectorAll(sel)) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent.trim();
      if (!text) continue;
      const el = n.parentElement;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width <= 1 || r.height <= 1 || cs.visibility === "hidden" || cs.color === "rgba(0, 0, 0, 0)") continue; // sr-only, hidden, skeleton
      const size = parseFloat(cs.fontSize);
      if (size === 0) continue; // a glyph replaced by a ::after label (notify dismiss)
      seen += 1;
      if (size < 15.9) small.push(`${el.tagName}.${el.className} "${text.slice(0, 24)}" ${cs.fontSize}`);
      const first = cs.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
      if (!brand.includes(first)) fonts.push(`${el.tagName}.${el.className} "${text.slice(0, 24)}" ${first}`);
    }
  }
  return { small, fonts, seen };
}, ISLANDS);

const brandFontLoaded = (page) => page.evaluate(async () => {
  await document.fonts.ready;
  return [...document.fonts].some((f) => f.family.replace(/["']/g, "") === "Source Sans 3" && f.status === "loaded");
});

/** Keyboard modality first (Tab), then focus the element: the ring is the one system rule, gold and 2px. */
async function ringOf(page, locator) {
  await page.keyboard.press("Tab");
  await locator.focus();
  return locator.evaluate((el) => { const cs = getComputedStyle(el); return { fv: el.matches(":focus-visible"), color: cs.outlineColor, style: cs.outlineStyle, width: cs.outlineWidth }; });
}
const expectGoldRing = (r, what) => {
  expect(r.fv, `${what} matches :focus-visible`).toBe(true);
  expect(r.style, what).toBe("solid");
  expect(r.color, what).toBe(RGB.focus);
  expect(r.width, what).toBe("2px");
};

const PAGES = { home: "/", posts: "/posts/", post: `/posts/?id=${FX.posts[0].id}`, person: "/person/?id=I9001", search: "/search/?q=Quillfeather", notifications: "/me/notifications/" };
// A post row, not a loading skeleton row (also .hfy-posts__item): an audit run while only the skeleton shows sees almost no text.
const READY = { home: "[data-hfy-timeline] .hfy-posts__item:has(.iok-content-card)", posts: "[data-hfy-posts] .hfy-posts__item:has(.iok-content-card)", post: "[data-hfy-comments] .io-comments-comment", person: "[data-hfy-comments] .io-comments-comment", search: "#hfy-search-v2 .hfy-search__row", notifications: ".hfy-notify [role=switch]" };

for (const width of [375, 1024]) {
  for (const [name, path] of Object.entries(PAGES)) {
    test(`${name} at ${width}: brand fonts in every island, no text under 16px`, async ({ page }) => {
      await stub(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${path}${path.includes("?") ? "&" : "?"}${FLAGS}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator(READY[name]).first()).toBeVisible();
      expect(await brandFontLoaded(page), "the self-hosted Source Sans 3 face loaded").toBe(true);
      const a = await textAudit(page);
      expect(a.seen, "the audit inspected the islands' text").toBeGreaterThan(4);
      expect(a.fonts, "text not in a brand face").toEqual([]);
      expect(a.small, "text under 16px").toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll").toBe(true);
    });
  }
}

test("posts at >=688: cards on surface.raised; meta 16px in text.dim; rows are hairline-separated below 688", async ({ page }) => {
  await stub(page);
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(`/posts/?${FLAGS}`, { waitUntil: "domcontentloaded" });
  // A post row, not a loading skeleton row (also .hfy-posts__item): the skeleton is visible first and has no meta to measure.
  const card = page.locator("[data-hfy-posts] .hfy-posts__item:has(.iok-content-card)").first();
  await expect(card).toBeVisible();
  const look = await card.evaluate((li) => {
    const cs = getComputedStyle(li);
    const time = li.querySelector(".iok-content-meta time");
    const t = getComputedStyle(time);
    return { bg: cs.backgroundColor, shadow: cs.boxShadow, timeSize: t.fontSize, timeColor: t.color, title: time.getAttribute("title"), timeText: time.textContent, heading: getComputedStyle(document.querySelector("[data-hfy-posts] h1")).fontFamily };
  });
  expect(look.bg).toBe(RGB.raised);
  expect(look.shadow).not.toBe("none");
  expect(look.timeSize).toBe("16px");
  expect(look.timeColor).toBe(RGB.dim);
  expect(look.timeText).toBe("3 hr ago");
  expect(look.title, "full date on hover").toMatch(/^[a-z]+ \d{1,2}, \d{4}, \d{1,2}:\d{2} (am|pm)$/);
  expect(look.heading).toMatch(/^"?Libre Caslon Text/);

  await page.setViewportSize({ width: 375, height: 812 });
  const row = await card.evaluate((li) => { const cs = getComputedStyle(li); return { bg: cs.backgroundColor, bottom: cs.borderBottomWidth, left: cs.borderLeftWidth }; });
  expect(row).toEqual({ bg: RGB.transparent, bottom: "1px", left: "0px" });
});

test("own page: composer post on accent with accent.text, 16px fields on surface.sunken, gold 2px focus rings", async ({ page }) => {
  await stub(page);
  await page.goto(`/person/?id=I9001&${FLAGS}`, { waitUntil: "domcontentloaded" });
  const mine = page.locator("#hfy-my-posts");
  const submit = mine.getByRole("button", { name: /^post$/ });
  await expect(submit).toBeVisible();
  await mine.getByRole("textbox").first().fill("a line");
  const look = await submit.evaluate((b) => { const cs = getComputedStyle(b); const ta = getComputedStyle(b.form.querySelector("textarea")); return { bg: cs.backgroundColor, color: cs.color, h: b.getBoundingClientRect().height, taBg: ta.backgroundColor, taSize: ta.fontSize }; });
  expect(look.bg).toBe(RGB.accent);
  expect(look.color).toBe(RGB.accentText);
  expect(look.h).toBeGreaterThanOrEqual(43.5);
  expect(look.taBg).toBe(RGB.sunken);
  expect(look.taSize).toBe("16px");
  expectGoldRing(await ringOf(page, submit), "composer post button");
  expectGoldRing(await ringOf(page, mine.getByRole("link", { name: /^comments/ }).first()), "comments link");
});

test("comments: no system colours (Canvas/Highlight), transparent over the surface, Post on accent, one control height", async ({ page }) => {
  await stub(page);
  await page.goto(`/posts/?id=${FX.posts[0].id}&${FLAGS}`, { waitUntil: "domcontentloaded" });
  const thread = page.locator("[data-hfy-comments] .io-comments");
  await expect(thread.locator(".io-comments-comment").first()).toBeVisible();
  const box = thread.getByRole("textbox");
  await box.fill("a synthetic comment");
  const look = await thread.evaluate((t) => {
    const probe = document.createElement("div");
    probe.style.cssText = "background:Canvas;color:CanvasText;border-color:Highlight;outline-color:HighlightText";
    document.body.appendChild(probe);
    const p = getComputedStyle(probe);
    const system = new Set([p.backgroundColor, p.color, p.borderTopColor, p.outlineColor, "rgb(255, 255, 255)"]);
    probe.remove();
    const bad = [];
    for (const el of [t, ...t.querySelectorAll("*")]) {
      if (el.getBoundingClientRect().width === 0) continue;
      const cs = getComputedStyle(el);
      for (const [k, v] of [["bg", cs.backgroundColor], ["color", cs.color], ["border", cs.borderTopStyle === "none" ? null : cs.borderTopColor]]) if (v && system.has(v)) bad.push(`${el.tagName}.${el.className} ${k} ${v}`);
    }
    const row = getComputedStyle(t.querySelector(".io-comments-comment"));
    const post = t.querySelector(".io-comments-post");
    const input = t.querySelector(".io-comments-input");
    const pressed = t.querySelector('.io-comments-reaction[aria-pressed="true"]');
    return {
      bad, threadBg: getComputedStyle(t).backgroundColor, rowBg: row.backgroundColor, rowBottom: row.borderBottomWidth, rowTop: row.borderTopWidth,
      postBg: getComputedStyle(post).backgroundColor, postColor: getComputedStyle(post).color, postH: post.getBoundingClientRect().height, postW: post.getBoundingClientRect().width,
      inputH: input.getBoundingClientRect().height, inputBg: getComputedStyle(input).backgroundColor, placeholder: input.getAttribute("placeholder"),
      pressedBg: pressed && getComputedStyle(pressed).backgroundColor, pressedBorder: pressed && getComputedStyle(pressed).borderTopWidth,
      surface: getComputedStyle(document.body).backgroundColor,
    };
  });
  expect(look.bad, "system colours in the thread").toEqual([]);
  expect(look.threadBg).toBe(RGB.transparent);
  expect(look.surface).toBe(RGB.surface);
  expect(look.rowBg).toBe(RGB.transparent);
  expect(look.rowTop).toBe("0px");
  expect(look.rowBottom).toBe("1px");
  expect(look.postBg).toBe(RGB.accent);
  expect(look.postColor).toBe(RGB.accentText);
  expect(look.postH).toBe(44);
  expect(look.inputH).toBe(44);
  expect(look.postW).toBeGreaterThanOrEqual(88);
  expect(look.inputBg).toBe(RGB.sunken);
  expect(look.placeholder).toBe("say something");
  expect(look.pressedBg).toBe(RGB.pill);
  expect(look.pressedBorder).toBe("1px");
  expectGoldRing(await ringOf(page, thread.locator(".io-comments-post")), "comment post button");
  expectGoldRing(await ringOf(page, thread.getByRole("button", { name: "react" })), "react pill");
});

test("search at 1024: sticky controls on surface, pills on token-pill, 'looking…' while the index loads, results in two columns", async ({ page }) => {
  await stub(page, { delayCorpusMs: 1200 });
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(`/search/?q=Quillfeather&${FLAGS}`, { waitUntil: "domcontentloaded" });
  const root = page.locator("#hfy-search-v2");
  await expect(root.locator(".io-search-header__count")).toHaveText("looking…");
  await expect(page.getByRole("status", { name: "loading the family index" })).toBeVisible();
  await expect(root.getByRole("link", { name: /Mary Quillfeather/ })).toBeVisible({ timeout: 10_000 });
  await expect(root.locator(".io-search-header__count")).toHaveText("2 people");
  const look = await root.evaluate((r) => {
    const cs = (s) => getComputedStyle(r.querySelector(s));
    const rows = [...r.querySelectorAll(".io-search__result")].map((li) => li.getBoundingClientRect());
    return {
      sticky: cs(".io-search__controls").backgroundColor, stickyPos: cs(".io-search__controls").position,
      pill: cs(".io-search-pills__pill").backgroundColor, pillColor: cs(".io-search-pills__pill").color, pillRadius: cs(".io-search-pills__pill").borderTopLeftRadius,
      title: cs(".io-search-header__title").fontFamily, count: cs(".io-search-header__count").color, countSize: cs(".io-search-header__count").fontSize,
      input: cs(".io-search__row1 input").backgroundColor, inputSize: cs(".io-search__row1 input").fontSize,
      h1Visible: r.querySelector("h1").getBoundingClientRect().width > 1,
      sameRow: rows.length === 2 && Math.abs(rows[0].top - rows[1].top) < 1,
      toggle: r.querySelectorAll(".io-search__controls-toggle").length,
    };
  });
  expect(look.sticky).toBe(RGB.surface);
  expect(look.stickyPos).toBe("sticky");
  expect(look.pill).toBe(RGB.pill);
  expect(look.pillRadius).toBe("999px");
  expect(look.title).toMatch(/^"?Libre Caslon Text/);
  expect(look.count).toBe(RGB.dim);
  expect(look.countSize).toBe("16px");
  expect(look.input).toBe(RGB.sunken);
  expect(look.inputSize).toBe("16px");
  expect(look.h1Visible, "the page h1 is visually hidden").toBe(false);
  expect(look.sameRow, "two result columns from 1024").toBe(true);
  expect(look.toggle, "no hide/show toggles link").toBe(0);
  expectGoldRing(await ringOf(page, root.getByRole("link", { name: /Mary Quillfeather/ })), "result link");
  expectGoldRing(await ringOf(page, root.getByRole("button", { name: /^Clear$/ })), "clear button");
});

test("notifications at 375: switch 52x32 with a 44 hit area, on = accent with an accent.text knob, off = border.strong", async ({ page }) => {
  await stub(page);
  await page.goto(`/me/notifications/?${FLAGS}`, { waitUntil: "domcontentloaded" });
  const on = page.locator('.hfy-notify [data-type="mention"] [role=switch]');
  const off = page.locator('.hfy-notify [data-type="reply_to_me"] [role=switch]');
  await expect(on).toHaveAttribute("aria-checked", "true");
  await expect(off).toHaveAttribute("aria-checked", "false");
  const sw = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const hit = getComputedStyle(el, "::before");
    const knob = getComputedStyle(el, "::after");
    return { w: r.width, h: r.height, bg: cs.backgroundColor, hitH: parseFloat(hit.height), knobW: knob.width, knobBg: knob.backgroundColor };
  };
  const a = await on.evaluate(sw);
  expect({ w: a.w, h: a.h }).toEqual({ w: 52, h: 32 });
  expect(a.hitH).toBeGreaterThanOrEqual(44);
  expect(a.bg).toBe(RGB.accent);
  expect(a.knobW).toBe("24px");
  expect(a.knobBg).toBe(RGB.accentText);
  expect((await off.evaluate(sw)).bg).toBe(RGB.borderStrong);
  const group = await page.locator(".hfy-notify .iok-notify-group > h4").first().evaluate((h) => { const cs = getComputedStyle(h); return { transform: cs.textTransform, spacing: cs.letterSpacing, size: cs.fontSize, text: h.textContent }; });
  expect(group).toEqual({ transform: "none", spacing: "normal", size: "16px", text: "about me" });
  expect(await page.locator(".hfy-notify .iok-notify-row").first().evaluate((li) => li.getBoundingClientRect().height)).toBeGreaterThanOrEqual(56);
  const chosen = page.locator('.hfy-notify [data-type="mention"] [role=radio][aria-checked=true]');
  expect(await chosen.evaluate((b) => [getComputedStyle(b).backgroundColor, getComputedStyle(b).color])).toEqual([RGB.accent, RGB.accentText]);
  expectGoldRing(await ringOf(page, on), "switch");
});

test("posts empty state: a display-serif line and one text.dim sentence, never a banner", async ({ page }) => {
  await stub(page);
  await page.route(/\/api\/posts\?/, (r) => r.fulfill({ json: { items: [], cursor: null } }));
  await page.goto(`/posts/?${FLAGS}`, { waitUntil: "domcontentloaded" });
  const empty = page.locator("[data-hfy-empty]");
  await expect(empty).toContainText("nothing posted yet.");
  await expect(empty).toContainText("be the first — a photo counts.");
  expect(await empty.locator(".hfy-empty__title").evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/^"?Libre Caslon Text/);
  await expect(page.locator("[data-hfy-banner]")).toHaveCount(0);
});
