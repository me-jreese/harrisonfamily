// HFY-TSK-218 (HFY-PLN-002 surfaces 4.5): the homepage on this day island (island onthisday, flag onThisDay), at 375 and 1280. The flag
// ships off, so the ?hfy_flags preview override turns it on. /auth and /api are stubbed; every person and string is synthetic.
import { test, expect } from "@playwright/test";
import { axeViolations } from "./axe.mjs";

const ME = { sub: "I0042", label: "Marie" };
const P = (id, name, lifeState = "deceased") => ({ grampsId: id, name, lifeState });
const DAY = {
  date: "2026-10-13", tier: "day", indexVersion: "v1", stale: false, posts: [], prompt: null,
  items: [
    { id: "evt:d1", kind: "death", tone: "remember", when: "day", n: 12, year: 2014, people: [P("I0001", "Wren Brambleton")] },
    { id: "evt:m1", kind: "marriage", tone: "celebrate", when: "day", n: 50, year: 1976, emoji: "❤️", people: [P("I0042", "Marie Quillfeather", "living"), P("I0003", "Tomas Quillfeather")] },
    { id: "evt:x", kind: "residence", tone: "neutral", when: "day", n: 3, year: 2023, place: "Springfield", people: [P("I0004", "Mary Example")] }
  ]
};

async function hermetic(page, { session = "in", body = DAY, status = 200, admin = false, hide = 204, onHide } = {}) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/auth/session", (r) => r.fulfill({ json: session === "in" ? { authenticated: true, sub: ME.sub, grampsId: ME.sub, label: ME.label } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/api/**", (r) => r.fulfill({ json: {} }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { id: ME.sub, label: ME.label, admin, can: {} } }));
  await page.route(/\/api\/onthisday\/hide/, (r) => { onHide?.(r.request().postDataJSON()); return r.fulfill({ status: hide, body: "" }); });
  await page.route(/\/api\/onthisday(\?|$)/, (r) => (status === 200 ? r.fulfill({ json: body }) : r.fulfill({ status, json: { error: "unavailable" } })));
}
const card = (page) => page.locator("[data-hfy-onthisday]");

for (const [name, viewport] of [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]]) {
  test(`${name} day tier: heading, date, rows, remembering last, gold and ink tones, 44px targets, mounts after the hero, axe clean`, async ({ page }) => {
    await hermetic(page);
    await page.setViewportSize(viewport);
    await page.goto("/?hfy_flags=onThisDay", { waitUntil: "domcontentloaded" });
    await expect(card(page).getByRole("heading", { level: 2, name: "on this day" })).toBeVisible();
    expect(await page.evaluate(() => document.querySelector("section.home-hero").nextElementSibling?.id)).toBe("hfy-onthisday");
    await expect(card(page)).toContainText("oct 13");
    const rows = card(page).locator("[data-hfy-otd-row]");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("Marie Quillfeather and Tomas Quillfeather got married 50 years ago today. ❤️");
    await expect(rows.nth(0)).toContainText("1976 · 50 years ago");
    await expect(rows.nth(2)).toContainText("remembering Wren Brambleton, who died 12 years ago today.");
    await expect(card(page).locator("[data-hfy-otd-remembering] h3")).toHaveText("remembering");
    // names link to /person/?id= (P2-R46)
    await expect(rows.nth(0).getByRole("link", { name: "Tomas Quillfeather" })).toHaveAttribute("href", "/person/?id=I0003");
    const m = await page.evaluate(() => {
      const css = (el, p) => getComputedStyle(el)[p];
      const celebrate = document.querySelector('[data-tone="celebrate"] .hfy-otd__glyph');
      const remember = document.querySelector('[data-tone="remember"] .hfy-otd__glyph');
      const probe = document.createElement("i");
      probe.style.color = "var(--io-color-semantic-accent-secondary)";
      document.body.appendChild(probe);
      const gold = getComputedStyle(probe).color;
      probe.remove();
      const targets = [...document.querySelectorAll("[data-hfy-onthisday] button, [data-hfy-onthisday] .hfy-otd__footer")].map((b) => b.getBoundingClientRect()).map((r) => ({ w: r.width, h: r.height }));
      return { gold, celebrate: css(celebrate, "color"), remember: css(remember, "color"), targets, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, text: document.querySelector("[data-hfy-onthisday]").innerText };
    });
    expect(m.celebrate).toBe(m.gold);
    expect(m.remember).not.toBe(m.gold);
    expect(m.targets.length).toBeGreaterThan(0);
    for (const t of m.targets) { expect(t.h).toBeGreaterThanOrEqual(44); expect(t.w).toBeGreaterThanOrEqual(44); }
    expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
    expect(await axeViolations(page)).toEqual([]);
  });
}

test("week and year tiers carry their headings", async ({ page }) => {
  const item = (when) => ({ id: "evt:w", kind: "graduation", tone: "celebrate", when, n: 20, year: 2006, detail: "Example College", people: [P("I0003", "Tomas Quillfeather")] });
  for (const [tier, heading] of [["week", "this week in family history"], ["year", "this year in family history"]]) {
    await hermetic(page, { body: { ...DAY, tier, items: [item(tier)] } });
    await page.goto("/?hfy_flags=onThisDay", { waitUntil: "domcontentloaded" });
    await expect(card(page).getByRole("heading", { level: 2, name: heading })).toBeVisible();
    await expect(card(page)).toContainText(`Tomas Quillfeather graduated from Example College 20 years ago ${tier === "week" ? "this week" : "this year"}.`);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("signed out renders nothing, and a 503 renders nothing", async ({ page }) => {
  await hermetic(page, { session: "out" });
  await page.goto("/?hfy_flags=onThisDay", { waitUntil: "domcontentloaded" });
  await expect(page.locator("section.home-hero")).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.locator("#hfy-onthisday")).toBeEmpty();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await hermetic(page, { status: 503 });
  await page.goto("/?hfy_flags=onThisDay", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  await expect(page.locator("#hfy-onthisday")).toBeEmpty();
});

test("the hide confirm: a person in the item may hide it (hide or keep); a stranger sees no control; an admin does", async ({ page }) => {
  const posted = [];
  await hermetic(page, { onHide: (b) => posted.push(b) });
  await page.goto("/?hfy_flags=onThisDay", { waitUntil: "domcontentloaded" });
  // only the marriage that includes the viewer (I0042) offers hide
  await expect(card(page).getByRole("button", { name: "hide this" })).toHaveCount(1);
  await card(page).getByRole("button", { name: "hide this" }).click();
  await expect(card(page)).toContainText("hide this from on this day?");
  await card(page).getByRole("button", { name: "keep" }).click();
  await expect(card(page)).not.toContainText("hide this from on this day?");
  await expect(card(page).locator("[data-hfy-otd-row]")).toHaveCount(3);
  await card(page).getByRole("button", { name: "hide this" }).click();
  await card(page).getByRole("button", { name: "hide", exact: true }).click();
  await expect(card(page).locator("[data-hfy-otd-row]")).toHaveCount(2);
  expect(posted).toEqual([{ itemId: "evt:m1" }]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await hermetic(page, { admin: true });
  await page.goto("/?hfy_flags=onThisDay", { waitUntil: "domcontentloaded" });
  await expect(card(page).getByRole("button", { name: "hide this" })).toHaveCount(3);
});

test("the add_day prompt renders only with recordEdit; otherwise the browse-only variant", async ({ page }) => {
  const body = { date: "2026-10-13", tier: "prompt", items: [], posts: [], prompt: { kind: "add_day", itemId: "evt:m", people: [P("I0002", "Ada Example", "living"), P("I0003", "Tomas Example", "living")] } };
  await hermetic(page, { body });
  await page.goto("/?hfy_flags=onThisDay,recordEdit", { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-hfy-otd-prompt="edit"]')).toHaveText("know the day Ada Example and Tomas Example got married? add it to their page.");
  await expect(page.locator('[data-hfy-otd-prompt="edit"]').getByRole("link", { name: "Ada Example" })).toHaveAttribute("href", "/person/?id=I0002");
  await page.goto("/?hfy_flags=onThisDay", { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-hfy-otd-prompt="browse"]')).toContainText("have a look at Ada Example and Tomas Example");
  await expect(page.locator('[data-hfy-otd-prompt="edit"]')).toHaveCount(0);
  await expect(card(page)).not.toContainText("add it to");
});

test("member-editable strings are text nodes: an <img onerror> fixture creates no element", async ({ page }) => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  const body = {
    date: "2026-10-13", tier: "day", posts: [], prompt: null,
    items: [
      { id: "evt:g", kind: "graduation", tone: "celebrate", when: "day", n: 20, year: 2006, detail: evil, people: [P("I0003", `Tomas ${evil}`)] },
      { id: "evt:r", kind: "residence", tone: "neutral", when: "day", n: 3, year: 2023, place: evil, people: [P("I0004", "Mary Example")] }
    ]
  };
  const archive = { date: "2026-10-13", tier: "archive", items: [], prompt: null, posts: [{ id: "01POST", n: 2, author: { id: "I0009", label: `Ida ${evil}` }, excerpt: evil, photo: { url: "/uploads/none.jpg", alt: evil } }] };
  for (const b of [body, archive]) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await hermetic(page, { body: b });
    await page.goto("/?hfy_flags=onThisDay", { waitUntil: "domcontentloaded" });
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText("<img src=x");
    // the only img allowed is the archive's own thumbnail (one, with the hostile text as its alt attribute value)
    await expect(card(page).locator("img")).toHaveCount(b === archive ? 1 : 0);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  }
});
