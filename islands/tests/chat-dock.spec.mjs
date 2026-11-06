// HFY-TSK-385 (fixes HFY-ISS-026; flag chatV1): the chat roster panel starts collapsed, opens and closes by button and Escape, remembers
// the choice per device without breaking when storage is unavailable, is capped to the viewport when open and does not cover the page's
// content on a desktop width. 375, 768, 1128 and 1280, both themes; axe at 375 and 1280. Stubbed routes, synthetic people, no service worker.
// Run:  HFY_SITE=<dir> PW_PORT=<port> PW_CHANNEL=chromium-headless-shell npx playwright test tests/chat-dock.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { axeViolations } from "./axe.mjs";
import { chatHub } from "./fixtures/chat-hub.mjs";

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
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

for (const scheme of ["light", "dark"]) {
  for (const [w, h] of SIZES) {
    test.describe(`${w}x${h} ${scheme}`, () => {
      test.use({ viewport: { width: w, height: h }, colorScheme: scheme });
      const wide = w >= 688; // 43rem: from here the roster panel is docked

      test("starts collapsed; button opens and closes; Escape closes; remembered; capped; clear of the content", async ({ page, context }) => {
        const hub = chatHub();
        hub.virtual("I9002");
        await wire(context, hub);
        await page.goto("/contact/", { waitUntil: "domcontentloaded" });
        if (!wide) {
          // a phone has no panel: the bar's chat entry stands in, and nothing is expanded
          await expect(page.locator('[data-slot="chat"] .io-chat-entry')).toBeVisible();
          await expect(panel(page)).toHaveCount(0);
          expect(await noHScroll(page)).toBe(true);
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
        const body = await page.locator(".io-chat-roster").evaluate((el) => getComputedStyle(el).overflowY);
        expect(body).toBe("auto");
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
    const hub = chatHub();
    await wire(context, hub);
    await page.goto("/contact/", { waitUntil: "domcontentloaded" });
    await bar(page).click();
    const box = await panel(page).boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(421);
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
