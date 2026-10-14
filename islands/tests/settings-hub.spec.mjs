// HFY-TSK-091 (HFY-PLN-002 surfaces §3.1-3.3): the /me/ settings hub, the `settings` island under navMe, at 375 and 1280.
// navMe is on in the build flags since its flip (HFY-TSK-223); the hub is still pinned on with the ?hfy_flags preview override, so no test leans on the build value.
// /auth and /api are stubbed; the member is synthetic. Run against the committed site (../11ty on 8089) or a scratch build:
// HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/settings-hub.spec.mjs
import { test, expect } from "@playwright/test";
import { axeViolations } from "./axe.mjs";

const ME = { sub: "I0042", label: "Marie" };
const HUB = "/me/?hfy_flags=navMe";
const TEXT_DIM = "rgb(205, 191, 166)"; // text.dim (archive-300)
const GOLD = "rgb(255, 193, 7)"; // accent.secondary (gold-400)

async function hermetic(page, { session = "in", hold = null } = {}) {
  const calls = [];
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/auth/session", async (r) => {
    if (hold) await hold;
    if (session === "unreachable") return r.fulfill({ status: 503, body: "down" });
    if (session === "no-sub") return r.fulfill({ json: { authenticated: true } }); // a broken session: authenticated, names nobody
    return r.fulfill({ json: session === "in" ? { authenticated: true, sub: ME.sub, grampsId: ME.sub, label: ME.label } : { authenticated: false } });
  });
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/auth/logout", (r) => { calls.push(`${r.request().method()} /auth/logout`); return r.fulfill({ status: 204, body: "" }); });
  await page.route("**/api/**", (r) => r.fulfill({ status: session === "in" ? 200 : 401, json: session === "in" ? {} : { error: "unauthenticated" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  return calls;
}

// Every control on the page and in the shell is a >= 44 x 44 target, every visible input is >= 16px, and nothing scrolls sideways.
async function audit(page) {
  return page.evaluate(() => {
    const small = [];
    document.querySelectorAll("#hfy-shell-root a[href], #hfy-shell-root button, .hfy-settings a[href], .hfy-settings button").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      if (el.closest(".hfy-content") && !el.closest(".hfy-settings")) return; // the page's footer links have their own spec
      if (r.height < 43.5 || r.width < 43.5) small.push(`${el.tagName} ${el.getAttribute("aria-label") || el.textContent.trim().slice(0, 24)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    });
    const smallInputs = [...document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea")]
      .filter((el) => el.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => el.outerHTML.slice(0, 60));
    return { small, smallInputs, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth };
  });
}

const hub = (page) => page.locator(".hfy-settings");
const row = (page, id) => page.locator(`.hfy-settings [data-hfy-setting="${id}"]`);

for (const [name, viewport] of [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]]) {
  test(`${name} signed in: the rows (label and dim line), sign out, 56px rows, 44px targets, no h-scroll, axe clean`, async ({ page }) => {
    await hermetic(page);
    await page.setViewportSize(viewport);
    await page.goto(HUB, { waitUntil: "domcontentloaded" });
    await expect(row(page, "notifications")).toBeVisible();
    await expect(page.locator("[data-settings-off]")).toHaveCount(0); // the "not turned on" note goes once the island runs
    await expect(page.getByRole("heading", { level: 1, name: "settings" })).toBeVisible();

    const notifications = page.getByRole("link", { name: "notifications", exact: true });
    await expect(notifications).toHaveAttribute("href", "/me/notifications/");
    await expect(notifications).toHaveAccessibleDescription("texts on this device, and what they're about");
    const signIn = page.getByRole("link", { name: "sign-in and devices", exact: true });
    await expect(signIn).toHaveAttribute("href", "/auth/link");
    await expect(signIn).toHaveAccessibleDescription("google, password, face or fingerprint");
    await expect(hub(page).getByRole("button", { name: "sign out", exact: true })).toBeVisible();
    // only these three (your links and family requests come with their own flags)
    await expect(page.locator(".hfy-settings [data-hfy-setting]")).toHaveCount(3);

    const rows = await page.locator(".hfy-settings .hfy-settings__row").evaluateAll((els) => els.map((e) => {
      const r = e.getBoundingClientRect();
      const icon = e.querySelector(".hfy-settings__icon");
      const line = e.querySelector(".hfy-settings__line");
      const ic = getComputedStyle(icon);
      return { h: r.height, w: r.width, icon: `${icon.getBoundingClientRect().width}x${icon.getBoundingClientRect().height}`, iconMask: (ic.maskImage || ic.webkitMaskImage || "").startsWith("url("), iconFill: ic.backgroundColor === getComputedStyle(e).color, line: line ? getComputedStyle(line).color : null, font: getComputedStyle(e).fontSize };
    }));
    for (const [i, r] of rows.entries()) {
      // 56 high (control.h.lg). At 375 a dim line may wrap and grow its row; "sign out" (the last, no line) is 56 at every width.
      if (viewport.width === 375 && i < rows.length - 1) expect(r.h).toBeGreaterThanOrEqual(56);
      else expect(r.h, `row ${i} height`).toBe(56);
      expect(r.icon).toBe("24x24");
      expect(r.iconMask, "the icon is a mask").toBe(true);
      expect(r.iconFill, "the icon is drawn in currentColor").toBe(true);
      expect(r.font).toBe("16px");
    }
    expect(rows.slice(0, 2).map((r) => r.line)).toEqual([TEXT_DIM, TEXT_DIM]);
    const width = await hub(page).evaluate((e) => e.getBoundingClientRect().width);
    if (viewport.width === 375) expect(Math.round(width)).toBe(375 - 2 * 16); // one full-width column inside the 16px gutter
    else expect(width).toBeLessThanOrEqual(640); // a 40rem column

    // the gear is current here: gold icon
    const gear = page.locator("#hfy-shell-root a.hfy-gear");
    await expect(gear).toHaveAttribute("aria-current", "page");
    expect(await gear.locator(".hfy-gear__icon").evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(GOLD);

    const a = await audit(page);
    expect(a.small, "targets < 44px").toEqual([]);
    expect(a.smallInputs, "inputs < 16px").toEqual([]);
    expect(a.scrollW).toBeLessThanOrEqual(a.innerW);
    expect(await axeViolations(page)).toEqual([]);
  });

  test(`${name} signed out: one line and a sign-in link back to /me/; no rows, no gear, axe clean`, async ({ page }) => {
    await hermetic(page, { session: "out" });
    await page.setViewportSize(viewport);
    await page.goto(HUB, { waitUntil: "domcontentloaded" });
    const gate = page.locator(".hfy-settings [data-hfy-gate]");
    await expect(gate).toBeVisible();
    await expect(gate.locator("p")).toHaveText("sign in to change your settings.");
    const signIn = gate.getByRole("link", { name: "sign in", exact: true });
    await expect(signIn).toHaveAttribute("href", "/auth/login?returnTo=%2Fme%2F");
    expect((await signIn.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await expect(page.locator(".hfy-settings [data-hfy-setting]")).toHaveCount(0);
    await expect(page.locator('#hfy-shell-root [data-hfy-account="signed-out"]')).toBeVisible();
    await expect(page.locator("#hfy-shell-root a.hfy-gear")).toHaveCount(0);
    const a = await audit(page);
    expect(a.small, "targets < 44px").toEqual([]);
    expect(a.scrollW).toBeLessThanOrEqual(a.innerW);
    expect(await axeViolations(page)).toEqual([]);
  });

  // The shell's rule, not "not explicitly signed out": with /auth/session unreachable the bar shows "sign in" and no gear, so the hub
  // offers no rows and no "sign out" either. Its sign-in link is the edge sign-in, as the account control's.
  test(`${name} /auth/session unreachable: the sign-in line (edge sign-in back to /me/), no rows, no sign out, no gear, axe clean`, async ({ page }) => {
    await hermetic(page, { session: "unreachable" });
    await page.setViewportSize(viewport);
    await page.goto(HUB, { waitUntil: "domcontentloaded" });
    const gate = page.locator(".hfy-settings [data-hfy-gate]");
    await expect(gate).toBeVisible();
    await expect(gate.locator("p")).toHaveText("sign in to change your settings.");
    await expect(gate.getByRole("link", { name: "sign in", exact: true })).toHaveAttribute("href", "/auth/login?returnTo=%2Fme%2F");
    await expect(page.locator(".hfy-settings [data-hfy-setting]")).toHaveCount(0);
    await expect(hub(page).getByRole("button", { name: "sign out" })).toHaveCount(0);
    await expect(page.locator('#hfy-shell-root [data-hfy-account="signed-out"]')).toBeVisible();
    await expect(page.locator("#hfy-shell-root a.hfy-gear")).toHaveCount(0);
    const a = await audit(page);
    expect(a.small, "targets < 44px").toEqual([]);
    expect(a.scrollW).toBeLessThanOrEqual(a.innerW);
    expect(await axeViolations(page)).toEqual([]);
  });
}

test("an authenticated session without a sub is not signed in: the sign-in line (edge sign-in), no rows, no gear", async ({ page }) => {
  await hermetic(page, { session: "no-sub" });
  await page.goto(HUB, { waitUntil: "domcontentloaded" });
  const gate = page.locator(".hfy-settings [data-hfy-gate]");
  await expect(gate).toBeVisible();
  await expect(gate.getByRole("link", { name: "sign in", exact: true })).toHaveAttribute("href", "/auth/login?returnTo=%2Fme%2F");
  await expect(page.locator(".hfy-settings [data-hfy-setting]")).toHaveCount(0);
  await expect(page.locator('#hfy-shell-root [data-hfy-account="signed-out"]')).toBeVisible();
  await expect(page.locator("#hfy-shell-root a.hfy-gear")).toHaveCount(0);
});

test("the hub's words are the DS voice: lowercase, no exclamation marks, never 'record'", async ({ page }) => {
  for (const session of ["in", "out", "unreachable"]) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await hermetic(page, { session });
    await page.goto(HUB, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".hfy-settings > :not([role=status][aria-label=loading])").first()).toBeVisible();
    const text = await page.locator("main").innerText();
    expect(text).toBe(text.toLowerCase());
    expect(text).not.toContain("!");
    expect(text).not.toMatch(/\brecords?\b|\busers?\b/);
  }
});

test("pending session: a one-row skeleton, then the rows", async ({ page }) => {
  let release;
  const hold = new Promise((r) => { release = r; });
  await hermetic(page, { hold });
  await page.goto(HUB, { waitUntil: "domcontentloaded" });
  await expect(page.locator('.hfy-settings [role="status"][aria-label="loading"]')).toBeVisible();
  await expect(hub(page)).toHaveAttribute("aria-busy", "true");
  release();
  await expect(row(page, "notifications")).toBeVisible();
  await expect(hub(page)).toHaveAttribute("aria-busy", "false");
});

test("'sign out' ends the edge session (POST /auth/logout) and lands on /logged-out/", async ({ page }) => {
  const calls = await hermetic(page);
  await page.goto(HUB, { waitUntil: "domcontentloaded" });
  await hub(page).getByRole("button", { name: "sign out", exact: true }).click();
  await page.waitForURL("**/logged-out/");
  expect(calls).toContain("POST /auth/logout");
});

test("navMe off: /me/ loads no settings island and keeps its 'not turned on' line", async ({ page }) => {
  await hermetic(page);
  const requested = [];
  page.on("request", (r) => { if (/\/js\/islands\/settings\./.test(r.url())) requested.push(r.url()); });
  await page.goto("/me/?hfy_flags=-navMe", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#hfy-shell-root .io-shell")).toBeVisible();
  await expect(page.locator("[data-settings-off]")).toHaveText("settings aren't turned on yet.");
  await page.waitForTimeout(300);
  expect(requested).toEqual([]);
  await expect(page.locator(".hfy-settings")).toHaveCount(0);
  await expect(page.locator("#hfy-shell-root a.hfy-gear")).toHaveCount(0);
});
