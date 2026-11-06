// HFY-TSK-385 (fixes HFY-ISS-026; flag chatV1): the chat roster panel starts collapsed, opens and closes by button and Escape, remembers
// the choice per device without breaking when storage is unavailable, is capped to the viewport when open and does not cover the page's
// content on a desktop width. 375, 768, 1128 and 1280, both themes; axe at 375 and 1280. Stubbed routes, synthetic people, no service worker.
// Run:  HFY_SITE=<dir> PW_PORT=<port> PW_CHANNEL=chromium-headless-shell npx playwright test tests/chat-dock.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { axeViolations } from "./axe.mjs";
import { chatHub, PEOPLE } from "./fixtures/chat-hub.mjs";

test.use({ serviceWorkers: "block" });

const ME = "I9001";
const FLAGS = { authV2: true, shellV2: true, navMe: true, notifyV2: true, searchV2: false, personV2: false, postsV2: false, aboutCta: false, chatV1: true };
const SIZES = [[375, 812], [768, 1024], [1128, 684], [1280, 800]];
const SHOTS = process.env.CHAT_SHOTS || "";

async function wire(context, hub, { flag = true } = {}) {
  await context.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await context.route("**/_data/flags.json", (r) => r.fulfill({ json: { ...FLAGS, chatV1: flag } }));
  await context.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: ME, grampsId: ME, label: "Sam Example", exp: Math.floor(Date.now() / 1000) + 3600 } }));
  await context.route("**/api/**", (r) => r.fulfill({ json: {} }));
  await hub.attach(context, { uid: ME });
}
const panel = (page) => page.getByTestId("io-chat-panel");
const bar = (page) => panel(page).getByRole("button", { name: "chat" });
// Forty synthetic members, so the roster is taller than any window here and must scroll inside the capped panel.
const MANY = [...PEOPLE, ...Array.from({ length: 40 }, (_, i) => ({ id: `I91${String(i).padStart(2, "0")}`, label: `Member${i} Example` }))];
// The leftmost edge of what the page shows inside its scroller (text, images, svg, canvas, controls), outside the chat's own elements, and
// of every fixed or absolutely placed element outside the scroller that is not the shell bar or the chat. `who` names the offender.
const leftmost = (page) => page.evaluate(() => {
  const vh = window.innerHeight, vw = window.innerWidth;
  const skip = (el) => el.closest(".io-chat, .io-chat-panel, .io-chat-dock, .io-shell__bar, [hidden], script, style");
  let best = { left: Infinity, who: "" };
  const note = (r, el) => {
    if (r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return;
    if (r.left < best.left) best = { left: r.left, who: `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).split(" ")[0]}` };
  };
  const scroller = document.querySelector(".hfy-scroller") || document.body;
  const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue.trim() || skip(n.parentElement)) continue;
    const st = getComputedStyle(n.parentElement);
    if (st.visibility === "hidden" || st.display === "none") continue;
    const rg = document.createRange();
    rg.selectNodeContents(n);
    for (const r of rg.getClientRects()) note(r, n.parentElement);
  }
  for (const el of scroller.querySelectorAll("img, svg, canvas, input, button, select, textarea")) {
    if (skip(el) || el.closest("svg") !== (el.tagName === "svg" ? null : el.closest("svg"))) continue;
    note(el.getBoundingClientRect(), el);
  }
  for (const el of document.querySelectorAll("body *")) {
    if (skip(el) || scroller.contains(el)) continue;
    const pos = getComputedStyle(el).position;
    if (pos === "fixed" || pos === "absolute" || pos === "sticky") {
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || el.contains(scroller)) continue;
      note(el.getBoundingClientRect(), el);
    }
  }
  return best;
});
// The roster lists the members who are online, so each synthetic member connects.
const crowd = (hub) => { for (const m of MANY.slice(2)) hub.virtual(m.id); };
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const scheme of ["light", "dark"]) {
  for (const [w, h] of SIZES) {
    test.describe(`${w}x${h} ${scheme}`, () => {
      test.use({ viewport: { width: w, height: h }, colorScheme: scheme });
      const wide = w >= 688; // 43rem: from here the roster panel is docked

      test("starts collapsed; button opens and closes; Escape closes; remembered; capped; clear of the content", async ({ page, context }) => {
        const hub = chatHub({ people: MANY });
        crowd(hub);
        await wire(context, hub);
        await page.goto("/contact/", { waitUntil: "domcontentloaded" });
        if (!wide) {
          // a phone has no panel: the bar's chat entry stands in, and nothing is expanded
          await expect(page.locator('[data-slot="chat"] .io-chat-entry')).toBeVisible();
          await expect(panel(page)).toHaveCount(0);
          expect(await noHScroll(page)).toBe(true);
          // Reading of the AC at phone widths: nothing docks, so there is no panel to collapse, open or close; the bar's entry goes to /chat/.
          await page.locator('[data-slot="chat"] .io-chat-entry').click();
          await expect(page).toHaveURL(/\/chat\/?$/);
          if (w === 375) expect(await axeViolations(page)).toEqual([]);
          hub.dispose();
          return;
        }
        await expect(bar(page)).toBeVisible();
        await expect(bar(page)).toHaveAttribute("aria-expanded", "false");
        await expect(panel(page).getByPlaceholder("search family")).toHaveCount(0);
        const closedBox = await panel(page).boundingBox();
        expect(closedBox.width).toBeLessThan(w / 4);
        expect((await bar(page).boundingBox()).height).toBeGreaterThanOrEqual(44);
        if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/chat-closed-${w}-${scheme}.png` }); }
        if (w === 1280) expect(await axeViolations(page)).toEqual([]);

        await bar(page).click();
        await expect(bar(page)).toHaveAttribute("aria-expanded", "true");
        await expect(panel(page).getByPlaceholder("search family")).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem("hfy:chat:panel"))).toBe("open");
        // capped to the viewport, with its own scroll
        const box = await panel(page).boundingBox();
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(h + 1);
        const roster = await page.locator(".io-chat-roster").evaluate((el) => ({ oy: getComputedStyle(el).overflowY, sh: el.scrollHeight, ch: el.clientHeight }));
        expect(roster.oy).toBe("auto");
        expect(roster.sh, "the roster is taller than the capped panel, so it scrolls inside it").toBeGreaterThan(roster.ch);
        const cap = await page.evaluate(() => {
          const px = (v) => { const d = document.createElement("div"); d.style.cssText = `position:absolute;visibility:hidden;height:${v}`; document.body.append(d); const h = d.getBoundingClientRect().height; d.remove(); return h; };
          const css = getComputedStyle(document.querySelector(".io-chat-panel")).maxHeight;
          return px(css);
        });
        expect(Math.abs(box.height - cap), `the open panel is as tall as its cap (${cap}px)`).toBeLessThanOrEqual(1);
        // does not cover the page's main content
        const main = await page.locator("main").first().boundingBox();
        const mainLeft = await page.evaluate(() => {
          const m = document.querySelector("main");
          const r = document.createRange();
          r.selectNodeContents(m);
          return Math.min(...[...r.getClientRects()].filter((x) => x.width > 0 && x.height > 0).map((x) => x.left));
        });
        expect(main).not.toBeNull();
        expect(mainLeft, "content starts right of the open panel").toBeGreaterThanOrEqual(box.x + box.width - 1);
        const lm = await leftmost(page);
        expect(lm.left, `nothing on the page (${lm.who}) sits under the open panel`).toBeGreaterThanOrEqual(box.x + box.width - 1);
        expect(await noHScroll(page)).toBe(true);
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-open-${w}-${scheme}.png` });
        if (w === 1280) expect(await axeViolations(page)).toEqual([]);

        // Escape closes it and focus returns to the launcher
        await page.keyboard.press("Escape");
        await expect(bar(page)).toHaveAttribute("aria-expanded", "false");
        await expect(bar(page)).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.classList.contains("hfy-chat-open"))).toBe(false);
        expect(await page.evaluate(() => localStorage.getItem("hfy:chat:panel"))).toBe("closed");

        // reopen by button, remembered on the next page
        await bar(page).click();
        await expect(panel(page).getByPlaceholder("search family")).toBeVisible();
        await page.goto("/about/", { waitUntil: "domcontentloaded" });
        await expect(bar(page)).toHaveAttribute("aria-expanded", "true");
        await bar(page).click();
        await page.goto("/contact/", { waitUntil: "domcontentloaded" });
        await expect(bar(page)).toHaveAttribute("aria-expanded", "false");
        hub.dispose();
      });
    });
  }
}

// The pages with their own layouts: the person page (siblings band, person card), the tree (side panel) and the family page.
test.describe("other pages keep clear of the open panel", () => {
  for (const [w, h] of [[1128, 684], [1280, 800]]) {
    for (const path of ["/person/?id=I9001", "/tree/?id=I9001", "/about/", "/"]) {
      test(`${path} at ${w}x${h}`, async ({ page, context }) => {
        await page.setViewportSize({ width: w, height: h });
        const hub = chatHub({ people: MANY });
        crowd(hub);
        await wire(context, hub);
        await page.goto(path, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(800);
        await bar(page).click();
        await expect(panel(page).getByPlaceholder("search family")).toBeVisible();
        const box = await panel(page).boundingBox();
        const lm = await leftmost(page);
        expect(lm.left, `${path}: ${lm.who} starts right of the panel`).toBeGreaterThanOrEqual(box.x + box.width - 1);
        expect(await noHScroll(page)).toBe(true);
        // control: without the reserve the same probe finds content under the panel, so the check can fail
        await page.evaluate(() => document.documentElement.style.setProperty("--io-hfy-chat-reserve", "0px"));
        const bare = await leftmost(page);
        expect(bare.left, "without the reserve the probe sees content under the panel").toBeLessThan(box.x + box.width - 1);
        hub.dispose();
      });
    }
  }
});

test.describe("unread, Escape and storage", () => {
  test.use({ viewport: { width: 1128, height: 684 } });

  test("a collapsed launcher carries the unread mark in its accessible name", async ({ page, context }) => {
    const hub = chatHub();
    const pat = hub.virtual("I9002");
    await wire(context, hub);
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await expect(bar(page)).toHaveAttribute("aria-expanded", "false");
    const before = await bar(page).evaluate((el) => ({ name: el.getAttribute("aria-label"), text: el.textContent, att: el.closest("[data-attention]")?.getAttribute("data-attention") ?? null }));
    pat.say(`dm:I9001:I9002`, "hello sam");
    await expect.poll(async () => bar(page).evaluate((el) => ({ name: el.getAttribute("aria-label"), text: el.textContent, att: el.closest("[data-attention]")?.getAttribute("data-attention") ?? null, desc: el.getAttribute("aria-describedby") })), { timeout: 5000 }).not.toEqual(before);
    const after = await bar(page).evaluate((el) => ({ name: el.getAttribute("aria-label"), text: el.textContent, att: el.closest("[data-attention]")?.getAttribute("data-attention") ?? null }));
    expect(after.text).toContain("unread");
    await expect(bar(page)).toHaveAccessibleName(/chat.*unread/i);
    hub.dispose();
  });

  test("Escape belongs to another overlay or field when focus is there", async ({ page, context }) => {
    const hub = chatHub();
    await wire(context, hub);
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await bar(page).click();
    await expect(panel(page).getByPlaceholder("search family")).toBeVisible();
    // focus on a page control outside the panel and a page widget that closes on Escape: the panel stays open
    await page.evaluate(() => {
      const b = document.createElement("button");
      b.id = "probe-pop";
      b.textContent = "popover";
      b.setAttribute("aria-expanded", "true");
      document.querySelector("main").prepend(b);
      const e = document.createElement("div");
      e.id = "probe-edit";
      e.contentEditable = "true";
      e.tabIndex = 0;
      e.textContent = "note";
      document.querySelector("main").prepend(e);
    });
    await page.locator("#probe-pop").focus();
    await page.keyboard.press("Escape");
    await expect(bar(page)).toHaveAttribute("aria-expanded", "true");
    await page.locator("#probe-edit").focus();
    await page.keyboard.press("Escape");
    await expect(bar(page)).toHaveAttribute("aria-expanded", "true");
    // a keydown that another handler already used (preventDefault) is left alone
    await page.evaluate(() => { document.getElementById("probe-pop").addEventListener("keydown", (e) => e.preventDefault()); });
    await page.locator("#probe-pop").focus();
    await page.keyboard.press("Escape");
    await expect(bar(page)).toHaveAttribute("aria-expanded", "true");
    // focus inside the panel: Escape closes it
    await bar(page).focus();
    await page.keyboard.press("Escape");
    await expect(bar(page)).toHaveAttribute("aria-expanded", "false");
    hub.dispose();
  });
});

test.describe("storage unavailable and flag off", () => {
  test.use({ viewport: { width: 1128, height: 684 } });

  test("storage that throws leaves the panel collapsed and still working", async ({ page, context }) => {
    const hub = chatHub();
    await wire(context, hub);
    await page.addInitScript(() => {
      const boom = () => { throw new Error("blocked"); };
      Object.defineProperty(window, "localStorage", { configurable: true, get: boom });
    });
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await expect(bar(page)).toHaveAttribute("aria-expanded", "false");
    await bar(page).click();
    await expect(panel(page).getByPlaceholder("search family")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(bar(page)).toHaveAttribute("aria-expanded", "false");
    hub.dispose();
  });

  test("a short window caps the open panel and scrolls inside it", async ({ page, context }) => {
    await page.setViewportSize({ width: 1128, height: 420 });
    const hub = chatHub({ people: MANY });
    crowd(hub);
    await wire(context, hub);
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await bar(page).click();
    const box = await panel(page).boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(421);
    const roster = await page.locator(".io-chat-roster").evaluate((el) => ({ oy: getComputedStyle(el).overflowY, sh: el.scrollHeight, ch: el.clientHeight }));
    expect(roster.oy).toBe("auto");
    expect(roster.sh).toBeGreaterThan(roster.ch);
    hub.dispose();
  });

  test("flag off adds nothing", async ({ page, context }) => {
    const hub = chatHub();
    await wire(context, hub, { flag: false });
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    await expect(panel(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.classList.contains("hfy-chat-open"))).toBe(false);
    hub.dispose();
  });
});
