// HFY-TSK-136 (HFY-PLN-002 surfaces 5): the /about/ call to action (island about-cta, flag aboutCta), at 375 and 1280, plus the search
// deep-link filters and the #share focus on the own-page composer. aboutCta ships off, so it is turned on with the ?hfy_flags preview
// override. /auth, /person data and /api are stubbed; the members and counts are synthetic.
import { test, expect } from "@playwright/test";
import { axeViolations } from "./axe.mjs";

const ME = { sub: "I0042", label: "Marie" };
const MANIFEST = { people: [
  { grampsId: "I0001", displayName: "Mary Quillfeather", isLiving: false, lifespanSummary: "1901 – 1980", primaryPhoto: { handle: "M1" } },
  { grampsId: "I0002", displayName: "Tomas Quillfeather", isLiving: true, lifespanSummary: "b. 1975", primaryPhoto: null },
  { grampsId: "I0003", displayName: "Ada Brambleton", isLiving: false, lifespanSummary: "", primaryPhoto: null },
  { grampsId: "I0004", displayName: "Wren Brambleton", isLiving: false, lifespanSummary: "1850 – 1920", primaryPhoto: null }
] };
const INDEX = { documents: MANIFEST.people.map((p) => ({ grampsId: p.grampsId, searchText: p.displayName.toLowerCase() })) };
const OWN_GAPS = { grampsId: ME.sub, displayName: "Marie Example", isLiving: true, primaryPhoto: null, notes: [], lifespan: { birth: {} } };

async function hermetic(page, { session = "in", manifest = 200, own = 200 } = {}) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/auth/session", (r) => r.fulfill({ json: session === "in" ? { authenticated: true, sub: ME.sub, grampsId: ME.sub, label: ME.label } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/person/index.json", (r) => (manifest === 200 ? r.fulfill({ json: MANIFEST }) : r.fulfill({ status: manifest, json: {} })));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: INDEX }));
  await page.route(`**/person/${ME.sub}.json`, (r) => (own === 200 ? r.fulfill({ json: OWN_GAPS }) : r.fulfill({ status: own, json: {} })));
  await page.route("**/api/**", (r) => r.fulfill({ json: {} }));
}
const cta = (page) => page.locator("[data-hfy-about-cta]");
const card = (page, id) => page.locator(`[data-hfy-card="${id}"]`);
const FULL = "aboutCta,recordEdit,commentPhotosV1";

for (const [name, viewport] of [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]]) {
  test(`${name} signed in, every target flag on: heading, lede, nudge, four cards with counts, closing; mounts after the hero; targets >= 44; axe clean`, async ({ page }) => {
    await hermetic(page);
    await page.setViewportSize(viewport);
    const storyBefore = await (async () => { await page.goto("/about/", { waitUntil: "domcontentloaded" }); return page.locator("section.about-hero").innerText(); })();
    await page.goto(`/about/?hfy_flags=${FULL}`, { waitUntil: "domcontentloaded" });
    await expect(cta(page).getByRole("heading", { level: 2, name: "the story isn't finished." })).toBeVisible();
    // mounted right after section.about-hero, in the page's main; the story is untouched
    expect(await page.evaluate(() => document.querySelector("section.about-hero").nextElementSibling?.id)).toBe("hfy-about-cta");
    expect(await page.locator("section.about-hero").innerText()).toBe(storyBefore);
    await expect(cta(page).locator("p").first()).toHaveText(/^it keeps going with every name, date and photo the family adds\./);
    await expect(page.locator("[data-hfy-nudge]")).toContainText("your page is missing a photo. start there?");
    await expect(page.locator("[data-hfy-nudge] a")).toHaveAttribute("href", "/person/?id=I0042");
    await expect(card(page, "look")).toContainText("4 people so far. find someone you remember.");
    await expect(card(page, "look")).toHaveAttribute("href", "/search/");
    await expect(card(page, "missing")).toContainText("1 person doesn't have a birth year yet. know one? add it.");
    await expect(card(page, "missing")).toHaveAttribute("href", "/search/?has_birth_year=false");
    await expect(card(page, "fix")).toContainText("see a wrong date or a misspelled name?");
    await expect(card(page, "fix")).toHaveAttribute("href", "/person/?id=I0042");
    await expect(card(page, "photos")).toContainText("3 people don't have a photo yet.");
    await expect(card(page, "photos")).toHaveAttribute("href", "/search/?has_photo=false");
    await expect(cta(page).locator(".hfy-about-cta__closing")).toHaveText("the memories live on.");

    const m = await page.evaluate(() => {
      const r = (el) => el.getBoundingClientRect();
      const cards = [...document.querySelectorAll("[data-hfy-card]")].map((c) => ({ w: r(c).width, h: r(c).height, x: Math.round(r(c).x), y: Math.round(r(c).y), title: parseFloat(getComputedStyle(c.querySelector(".hfy-about-cta__title")).fontSize) }));
      const text = document.querySelector("[data-hfy-about-cta]").innerText;
      return { cards, text, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth };
    });
    for (const c of m.cards) { expect(c.h).toBeGreaterThanOrEqual(44); expect(c.title).toBe(18); }
    if (viewport.width === 375) expect(new Set(m.cards.map((c) => c.x)).size).toBe(1); // one column
    else expect(new Set(m.cards.map((c) => c.y)).size).toBe(2); // 2 x 2
    expect(m.text).toBe(m.text.toLowerCase());
    expect(m.text).not.toContain("!");
    expect(m.text).not.toMatch(/\brecords?\b|\busers?\b|\bmembers?\b/);
    expect(m.scrollW).toBeLessThanOrEqual(m.innerW);
    expect(await axeViolations(page)).toEqual([]);
  });
}

test("signed out: nothing renders, and no gated data is fetched", async ({ page }) => {
  await hermetic(page, { session: "out" });
  const gated = [];
  page.on("request", (r) => { if (/\/person\/.*\.json/.test(r.url())) gated.push(r.url()); });
  await page.goto(`/about/?hfy_flags=${FULL}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("section.about-hero")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.locator("#hfy-about-cta")).toHaveCount(1);
  await expect(page.locator("#hfy-about-cta")).toBeEmpty();
  await expect(cta(page)).toHaveCount(0);
  expect(gated).toEqual([]);
});

test("aboutCta off (the shipped default): the island is not even requested", async ({ page }) => {
  await hermetic(page);
  const asked = [];
  page.on("request", (r) => { if (/\/js\/islands\/about-cta\./.test(r.url())) asked.push(r.url()); });
  await page.goto("/about/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("section.about-hero")).toBeVisible();
  await page.waitForTimeout(400);
  expect(asked).toEqual([]);
  await expect(page.locator("#hfy-about-cta")).toHaveCount(0);
});

test("the counts fetch fails: the cards render without numbers (the nudge still shows)", async ({ page }) => {
  await hermetic(page, { manifest: 500 });
  await page.goto(`/about/?hfy_flags=${FULL}`, { waitUntil: "domcontentloaded" });
  await expect(card(page, "look")).toHaveText(/find someone you remember\./);
  await expect(card(page, "look")).not.toContainText("so far");
  expect(await cta(page).evaluate((e) => /\d/.test([...e.querySelectorAll(".hfy-about-cta__line")].map((l) => l.textContent).join(" ")))).toBe(false);
  await expect(page.locator("[data-hfy-nudge]")).toBeVisible();
  await expect(page.locator("[data-hfy-card]")).toHaveCount(4);
});

test("the own record fails: the nudge is omitted, the cards keep their counts", async ({ page }) => {
  await hermetic(page, { own: 404 });
  await page.goto(`/about/?hfy_flags=${FULL}`, { waitUntil: "domcontentloaded" });
  await expect(card(page, "look")).toContainText("4 people so far.");
  await expect(page.locator("[data-hfy-nudge]")).toHaveCount(0);
});

test("both fetches fail: four cards, no numbers, no nudge", async ({ page }) => {
  await hermetic(page, { manifest: 500, own: 500 });
  await page.goto(`/about/?hfy_flags=${FULL}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-hfy-card]")).toHaveCount(4);
  await expect(page.locator("[data-hfy-nudge]")).toHaveCount(0);
});

test("loading: skeleton cards until the data lands", async ({ page }) => {
  let release;
  const hold = new Promise((r) => { release = r; });
  await hermetic(page);
  await page.route("**/person/index.json", async (r) => { await hold; return r.fulfill({ json: MANIFEST }); });
  await page.goto(`/about/?hfy_flags=${FULL}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator('.hfy-about-cta__skeletons[role="status"]')).toBeVisible();
  await expect(page.locator(".hfy-about-cta__skeleton")).toHaveCount(4);
  release();
  await expect(card(page, "look")).toBeVisible();
  await expect(page.locator(".hfy-about-cta__skeletons")).toHaveCount(0);
});

// One test per combination of the target flags: recordEdit (the two edit cards), commentPhotosV1 and postsV2 (the photo card).
for (const recordEdit of [false, true]) for (const commentPhotosV1 of [false, true]) for (const postsV2 of [false, true]) {
  test(`flags recordEdit=${recordEdit} commentPhotosV1=${commentPhotosV1} postsV2=${postsV2}: full or browse-only cards`, async ({ page }) => {
    await hermetic(page);
    const flags = ["aboutCta", recordEdit ? "recordEdit" : "-recordEdit", commentPhotosV1 ? "commentPhotosV1" : "-commentPhotosV1", postsV2 ? "postsV2" : "-postsV2"].join(",");
    await page.goto(`/about/?hfy_flags=${flags}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-hfy-card]")).toHaveCount(4);
    await expect(card(page, "look")).toHaveAttribute("data-hfy-variant", "edit");
    await expect(card(page, "missing")).toHaveAttribute("data-hfy-variant", recordEdit ? "edit" : "browse");
    await expect(card(page, "fix")).toHaveAttribute("data-hfy-variant", recordEdit ? "edit" : "browse");
    await expect(card(page, "missing").locator(".hfy-about-cta__title")).toHaveText(recordEdit ? "add what's missing" : "see what's missing");
    await expect(card(page, "fix").locator(".hfy-about-cta__title")).toHaveText(recordEdit ? "fix what's wrong" : "check your page");
    const photoFull = commentPhotosV1 || postsV2;
    await expect(card(page, "photos")).toHaveAttribute("data-hfy-variant", photoFull ? "edit" : "browse");
    await expect(card(page, "photos").locator(".hfy-about-cta__title")).toHaveText(photoFull ? "add photos" : "look at photos");
    await expect(card(page, "photos")).toHaveAttribute("href", commentPhotosV1 || !postsV2 ? "/search/?has_photo=false" : "/person/?id=I0042#share");
  });
}

// ---- the search deep links (the island seeds filter tokens from the URL) ----
test("/search/?has_photo=false lists only people without a photo, with a visible, removable filter", async ({ page }) => {
  await hermetic(page);
  await page.goto("/search/?has_photo=false&hfy_flags=searchV2", { waitUntil: "domcontentloaded" });
  const root = page.locator("#hfy-search-v2");
  await expect(root.locator(".io-search-header__count")).toHaveText("3 people");
  await expect(root.getByRole("link", { name: /Mary Quillfeather/ })).toHaveCount(0);
  for (const n of [/Tomas Quillfeather/, /Ada Brambleton/, /Wren Brambleton/]) await expect(root.getByRole("link", { name: n })).toBeVisible();
  await expect(root).toContainText("Filter (1)"); // the active filter is shown as a pill (the id is in the URL)
  await expect(root).toContainText(/has a phot/i);
});

test("/search/?has_photo=true lists only people with a photo", async ({ page }) => {
  await hermetic(page);
  await page.goto("/search/?has_photo=true&hfy_flags=searchV2", { waitUntil: "domcontentloaded" });
  const root = page.locator("#hfy-search-v2");
  await expect(root.locator(".io-search-header__count")).toHaveText("1 person");
  await expect(root.getByRole("link", { name: /Mary Quillfeather/ })).toBeVisible();
});

test("/search/?has_birth_year=false lists only people without a birth year", async ({ page }) => {
  await hermetic(page);
  await page.goto("/search/?has_birth_year=false&hfy_flags=searchV2", { waitUntil: "domcontentloaded" });
  const root = page.locator("#hfy-search-v2");
  await expect(root.locator(".io-search-header__count")).toHaveText("1 person");
  await expect(root.getByRole("link", { name: /Ada Brambleton/ })).toBeVisible();
});

test("/search/?living=true and a bad value: living filters, an unknown value is ignored", async ({ page }) => {
  await hermetic(page);
  await page.goto("/search/?living=true&has_photo=maybe&hfy_flags=searchV2", { waitUntil: "domcontentloaded" });
  const root = page.locator("#hfy-search-v2");
  await expect(root.locator(".io-search-header__count")).toHaveText("1 person");
  await expect(root.getByRole("link", { name: /Tomas Quillfeather/ })).toBeVisible();
});

// ---- #share on the own page ----
test("/person/?id=<me>#share: the composer section has id=share and the composer is focused", async ({ page }) => {
  await hermetic(page);
  await page.route("**/person/I0042.json", (r) => r.fulfill({ json: { grampsId: "I0042", displayName: "Marie Example", isLiving: true, gender: "female", notes: [{ raw: "# early life\n\nA synthetic note.", html: "<p>x</p>" }] } }));
  await page.route("**/api/posts**", (r) => r.fulfill({ json: { items: [], cursor: null } }));
  await page.route("**/api/comments**", (r) => r.fulfill({ json: { thread: { id: "x", topic: "comments", comments: [], reactions: {} } } }));
  await page.goto("/person/?id=I0042&hfy_flags=postsV2#share", { waitUntil: "domcontentloaded" });
  const section = page.locator("section#share");
  await expect(section).toBeVisible();
  await expect(section.getByRole("heading", { name: "share something" })).toBeVisible();
  await expect(section.getByRole("textbox").first()).toBeFocused();
  expect(await page.locator("#share").count()).toBe(1);
});

test("/person/?id=<me> without the hash does not steal focus", async ({ page }) => {
  await hermetic(page);
  await page.route("**/person/I0042.json", (r) => r.fulfill({ json: { grampsId: "I0042", displayName: "Marie Example", isLiving: true, gender: "female", notes: [{ raw: "# early life\n\nA synthetic note.", html: "<p>x</p>" }] } }));
  await page.route("**/api/posts**", (r) => r.fulfill({ json: { items: [], cursor: null } }));
  await page.route("**/api/comments**", (r) => r.fulfill({ json: { thread: { id: "x", topic: "comments", comments: [], reactions: {} } } }));
  await page.goto("/person/?id=I0042&hfy_flags=postsV2", { waitUntil: "domcontentloaded" });
  await expect(page.locator("section#share")).toBeVisible();
  await expect(page.locator("section#share").getByRole("textbox").first()).not.toBeFocused();
});
