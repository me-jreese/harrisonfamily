// HFY-TSK-169 (HFY-PLN-002 surfaces 8): photo tags on the person gallery and lightbox (island photo-tags, flag photoTags), at 375 and 1280.
// Synthetic people and photos only; /auth, /api, the flags file, the person JSON and the media are stubbed by route interception.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/photo-tags.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
const URL_PATH = "/person/?id=I9001";
const EVIL = '<img src=x onerror="window.__pwned=1">';
// photo sizes: landscape, portrait, square, landscape
const SIZES = { MTAG1: [800, 600], MTAG2: [600, 900], MTAG3: [700, 700], MTAG5: [800, 600] };
const svg = (name) => { const [w, h] = SIZES[name] || [800, 600]; return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="gray"/></svg>`; };

const TAGGED = {
  ...PERSON,
  mediaGallery: [
    { handle: "MTAG1", mime: "image/jpeg", title: "Landscape group", grampsId: "O1", tags: [
      { grampsId: "I9002", name: "Spouse Example", rect: [10, 20, 30, 50], isPrimary: false, attributes: [{ type: "Label", value: "left of the door" }], notes: ["A synthetic note about this tag."], citations: ["Synthetic Source One"], source: "gramps" },
      { grampsId: "I9012", name: "Father Example", rect: [90, 45, 60, 15], isPrimary: true, attributes: [], notes: [], citations: [], source: "site" },
      { grampsId: "I9015", name: "Child Example", rect: null, isPrimary: false, attributes: [], notes: [], citations: [], source: "gramps" }
    ] },
    { handle: "MTAG2", mime: "image/jpeg", title: "Portrait", grampsId: "O2", tags: [
      { grampsId: "I9001", name: "Test Person (synthetic)", rect: [20, 30, 80, 70], isPrimary: false, attributes: [], notes: [], citations: [], source: "gramps" }
    ] },
    { handle: "MTAG3", mime: "image/jpeg", title: "Square", grampsId: "O3", tags: [
      { grampsId: "I9014", name: "Sibling Example", rect: [25, 25, 75, 75], isPrimary: false, attributes: [], notes: [], citations: [], source: "gramps" },
      { grampsId: "I9099", name: "Stranger Example", rect: [0, 0, 20, 20], isPrimary: false, attributes: [], notes: [], citations: [], source: "gramps" }
    ] },
    { title: "Missing photo", grampsId: "O4", tags: [
      { grampsId: "I9014", name: "Sibling Example", rect: [25, 25, 75, 75], isPrimary: false, attributes: [], notes: [], citations: [], source: "gramps" },
      { grampsId: "I9002", name: "Spouse Example", rect: null, isPrimary: false, attributes: [], notes: [], citations: [], source: "gramps" }
    ] },
    { handle: "MTAG5", mime: "image/jpeg", title: "Hostile values", grampsId: "O5", tags: [
      { grampsId: "I9002", name: EVIL, rect: [10, 10, 40, 40], isPrimary: false, attributes: [{ type: EVIL, value: EVIL }], notes: [EVIL], citations: [EVIL], source: "gramps" }
    ] },
    { handle: "MTAG1", mime: "image/jpeg", title: "No tags here", grampsId: "O6" }
  ]
};
// tag index -> normalised rect, per photo, as the island must draw them (ordered corners; null rects draw nothing)
const RECTS = {
  0: { 0: [10, 20, 30, 50], 1: [60, 15, 90, 45] },
  1: { 0: [20, 30, 80, 70] },
  2: { 0: [25, 25, 75, 75], 1: [0, 0, 20, 20] },
  4: { 0: [10, 10, 40, 40] }
};

async function stub(page, { flag = true, person = TAGGED, delayIsland = 0, delayCatchUp = 0 } = {}) {
  const hits = { island: 0, person: 0 };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: flag } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: "I9002", grampsId: "I9002", label: "Sam Example" } }));
  await page.route("**/api/**", (r) => r.fulfill({ json: {} }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route("**/person/I9001.json", async (r) => {
    hits.person += 1;
    // the island's own read is the second request; holding it keeps the island without a person for a while
    if (delayCatchUp && hits.person === 2) await new Promise((res) => setTimeout(res, delayCatchUp));
    return r.fulfill({ json: person });
  });
  await page.route("**/media/tree_I9001.svg", (r) => r.fulfill({ contentType: "image/svg+xml", body: readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8") }));
  await page.route(/\/media\/MTAG\d\.jpg/, (r) => r.fulfill({ contentType: "image/svg+xml", body: svg(r.request().url().match(/MTAG\d/)[0]) }));
  await page.route(/\/js\/islands\/photo-tags\.js/, async (r) => {
    hits.island += 1;
    if (delayIsland) await new Promise((res) => setTimeout(res, delayIsland));
    return r.continue();
  });
  return hits;
}

async function openPerson(page, opts) {
  const hits = await stub(page, opts);
  await page.goto(URL_PATH, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-hero h1")).toHaveText("Test Person (synthetic)");
  return hits;
}

const figure = (page, i) => page.locator("#person-media-grid .gallery-item").nth(i);
async function ready(page, i) {
  await figure(page, i).scrollIntoViewIfNeeded();
  await expect(figure(page, i).locator(".photo-tags__region").first()).toBeVisible();
}

/** Largest distance, in px, between each region's box and the box computed from the image's contained rect (null when the image is not laid out). */
async function misfit(page, hostSel, imgSel, rects) {
  return page.evaluate(({ hostSel, imgSel, rects }) => {
    const host = document.querySelector(hostSel);
    const img = host.querySelector(imgSel);
    const r = img.getBoundingClientRect();
    const cs = getComputedStyle(img);
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const w = r.width - bl - (parseFloat(cs.borderRightWidth) || 0);
    const h = r.height - bt - (parseFloat(cs.borderBottomWidth) || 0);
    const s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    const cw = img.naturalWidth * s;
    const ch = img.naturalHeight * s;
    const ox = r.left + bl + (w - cw) / 2;
    const oy = r.top + bt + (h - ch) / 2;
    let worst = 0;
    let n = 0;
    for (const [i, [x1, y1, x2, y2]] of Object.entries(rects)) {
      const el = host.querySelector(`.photo-tags__region[data-tag="${i}"]`);
      if (!el) return { missing: i };
      const b = el.getBoundingClientRect();
      const want = [ox + (x1 / 100) * cw, oy + (y1 / 100) * ch, ox + (x2 / 100) * cw, oy + (y2 / 100) * ch];
      worst = Math.max(worst, ...[b.left - want[0], b.top - want[1], b.right - want[2], b.bottom - want[3]].map(Math.abs));
      n += 1;
    }
    return { worst, n, count: host.querySelectorAll(".photo-tags__region").length };
  }, { hostSel, imgSel, rects });
}

for (const [name, viewport] of [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 900 }]]) {
  test(`${name}: gallery regions sit within 1px of the contained image box (landscape, portrait, square); the layer is decorative`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPerson(page);
    for (const i of [0, 1, 2, 4]) {
      await ready(page, i);
      await figure(page, i).locator("button.media-lightbox-trigger").evaluate((el, id) => { el.id = id; }, `pt-host-${i}`);
      await expect.poll(async () => {
        const res = await misfit(page, `#pt-host-${i}`, "img", RECTS[i]);
        return res.missing ? 99 : res.worst;
      }).toBeLessThan(1);
      const res = await misfit(page, `#pt-host-${i}`, "img", RECTS[i]);
      expect(res.count).toBe(Object.keys(RECTS[i]).length); // a null rect draws nothing
      const layer = figure(page, i).locator(".photo-tags__layer");
      await expect(layer).toHaveAttribute("aria-hidden", "true");
      expect(await layer.locator("a, button, [tabindex]").count()).toBe(0);
      expect(await layer.evaluate((el) => el.closest("button.media-lightbox-trigger") !== null)).toBe(true);
    }
    // the regions track a resize of the box
    if (viewport.width === 1280) {
      await page.setViewportSize({ width: 900, height: 900 });
      await expect.poll(async () => (await misfit(page, "#pt-host-0", "img", RECTS[0])).worst).toBeLessThan(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  });
}

test("a photo without tags and a flag-off page get nothing; the flag-off page never requests the island", async ({ page }) => {
  const hits = await openPerson(page, { flag: false });
  await expect(page.locator("#person-media-grid .gallery-item")).toHaveCount(6);
  expect(await page.locator("[class*='photo-tags']").count()).toBe(0);
  expect(hits.island).toBe(0);
  await page.close();
});

test("a photo without tags has no layer and no list (flag on)", async ({ page }) => {
  await openPerson(page);
  await ready(page, 0);
  expect(await figure(page, 5).locator("[class*='photo-tags']").count()).toBe(0);
  expect(await figure(page, 0).locator("ul.photo-tags__names").count()).toBe(1);
});

test("names list: under the caption, in the data's order, labelled, and the image points at it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPerson(page);
  await ready(page, 0);
  const fig = figure(page, 0);
  const list = fig.locator("ul.photo-tags__names");
  await expect(list).toHaveAttribute("aria-label", "in this photo");
  expect(await fig.evaluate((f) => f.querySelector(".gallery-caption").nextElementSibling.querySelector("ul.photo-tags__names") !== null)).toBe(true);
  await expect(list.locator("button.photo-tags__name")).toHaveText(["Spouse Example", "Father Example", "Child Example"]);
  const id = await list.getAttribute("id");
  expect((await fig.locator("img").getAttribute("aria-describedby")).split(" ")).toContain(id);
  for (const b of await list.locator("button").all()) {
    expect(await b.getAttribute("aria-expanded")).toBe("false");
    expect(await page.locator(`#${await b.getAttribute("aria-controls")}`).count()).toBe(1);
    expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(44);
  }
  // clicking the thumbnail still opens the lightbox
  await fig.locator("button.media-lightbox-trigger").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#mediaLightboxImage")).toBeVisible();
});

test("1280 hover on a name: its region is highlighted and the hovercard shows the Gramps tag data; the site's line is separate; Esc dismisses", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPerson(page);
  await ready(page, 0);
  const fig = figure(page, 0);
  const first = fig.locator("button.photo-tags__name").nth(0);
  const region = fig.locator('.photo-tags__region[data-tag="0"]');
  await first.hover();
  const card = fig.locator(".photo-tags__item").nth(0).locator('[role="tooltip"]');
  await expect(card).toBeVisible();
  await expect(region).toHaveClass(/is-active/);
  await expect(region.locator(".photo-tags__label")).toBeVisible();
  expect(await first.getAttribute("aria-describedby")).toBe(await card.getAttribute("id"));
  const dt = await card.locator("dt").allTextContents();
  expect(dt).toEqual(["area", "attributes", "notes", "citations", "source"]);
  await expect(card).toContainText("left · 10% from the left, 20% from the top, 20% wide, 30% tall");
  await expect(card).toContainText("Label: left of the door");
  await expect(card).toContainText("A synthetic note about this tag.");
  await expect(card).toContainText("Synthetic Source One");
  await expect(card).toContainText("tagged in the family tree");
  const site = card.locator(".photo-tags__site");
  await expect(site).toHaveText("from this site, not the tag: the spouse of this page's person");
  expect(await card.locator("dl").evaluate((dl) => dl.textContent.includes("spouse"))).toBe(false);
  expect(await card.locator("a, button").count()).toBe(0); // plain text
  // the card can itself be hovered, and stays inside the viewport
  const box = await card.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1280);
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.waitForTimeout(300);
  await expect(card).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(page.locator("#mediaLightbox")).toBeHidden();
  // leaving removes the highlight
  await first.hover();
  await expect(card).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(card).toBeHidden();
  await expect(region).not.toHaveClass(/is-active/);
  // a name with no area: the card says so
  await fig.locator("button.photo-tags__name").nth(2).hover();
  await expect(fig.locator(".photo-tags__item").nth(2).locator('[role="tooltip"]')).toContainText("no area marked");
  expect(await fig.locator('.photo-tags__region[data-tag="2"]').count()).toBe(0);
  // the portrait flag on the second tag
  await fig.locator("button.photo-tags__name").nth(1).hover();
  await expect(fig.locator(".photo-tags__item").nth(1).locator('[role="tooltip"]')).toContainText("Father Example · their portrait");
  await expect(fig.locator(".photo-tags__item").nth(1).locator('[role="tooltip"]')).toContainText("tagged on the site");
});

test("1280 keyboard focus on a name shows the card and the region; Enter pins the panel with the page link; the thumbnail's focus shows every label", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPerson(page);
  await ready(page, 0);
  const fig = figure(page, 0);
  await fig.locator("button.media-lightbox-trigger").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab"); // keyboard modality: focus-visible
  await expect(fig.locator("button.media-lightbox-trigger")).toBeFocused();
  await expect(fig.locator(".photo-tags__region .photo-tags__label").first()).toBeVisible();
  await expect(fig.locator(".photo-tags__region .photo-tags__label").nth(1)).toBeVisible();
  await page.keyboard.press("Tab");
  const first = fig.locator("button.photo-tags__name").nth(0);
  await expect(first).toBeFocused();
  await expect(fig.locator('.photo-tags__item [role="tooltip"]').nth(0)).toBeVisible();
  await expect(fig.locator('.photo-tags__region[data-tag="0"]')).toHaveClass(/is-active/);
  await page.keyboard.press("Enter");
  const panel = page.locator(`#${await first.getAttribute("aria-controls")}`);
  await expect(panel).toBeVisible();
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await expect(fig.locator('[role="tooltip"]').nth(0)).toBeHidden();
  await expect(panel.locator("a.photo-tags__open")).toHaveText("open Spouse Example's page");
  await expect(panel.locator("a.photo-tags__open")).toHaveAttribute("href", "/person/?id=I9002");
  await expect(fig.locator('.photo-tags__region[data-tag="0"]')).toHaveClass(/is-active/);
  await page.keyboard.press("Enter");
  await expect(panel).toBeHidden();
  await expect(first).toHaveAttribute("aria-expanded", "false");
});

test.describe("touch at 375", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });
  test("a tap toggles the pinned panel: the same data, the page link, full width under the list; no hover-only information", async ({ page }) => {
    await openPerson(page);
    await ready(page, 0);
    const fig = figure(page, 0);
    const first = fig.locator("button.photo-tags__name").nth(0);
    await first.tap();
    const panel = page.locator(`#${await first.getAttribute("aria-controls")}`);
    await expect(panel).toBeVisible();
    await expect(first).toHaveAttribute("aria-expanded", "true");
    await expect(fig.locator('[role="tooltip"]').nth(0)).toBeHidden();
    await expect(panel).toContainText("left · 10% from the left, 20% from the top, 20% wide, 30% tall");
    await expect(panel).toContainText("Label: left of the door");
    await expect(panel).toContainText("A synthetic note about this tag.");
    await expect(panel).toContainText("Synthetic Source One");
    await expect(panel).toContainText("from this site, not the tag: the spouse of this page's person");
    const open = panel.locator("a.photo-tags__open");
    await expect(open).toHaveAttribute("href", "/person/?id=I9002");
    expect((await open.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await expect(fig.locator('.photo-tags__region[data-tag="0"]')).toHaveClass(/is-active/);
    // full width under the list: the panel spans the figure
    const [pb, fb] = await Promise.all([panel.boundingBox(), fig.boundingBox()]);
    expect(pb.width).toBeGreaterThan(fb.width - 4);
    // a second tap on another name moves the pin; a tap on the same name closes it
    const second = fig.locator("button.photo-tags__name").nth(1);
    await second.tap();
    await expect(panel).toBeHidden();
    await expect(fig.locator('.photo-tags__region[data-tag="0"]')).not.toHaveClass(/is-active/);
    await expect(fig.locator('.photo-tags__region[data-tag="1"]')).toHaveClass(/is-active/);
    await second.tap();
    await expect(fig.locator('.photo-tags__region[data-tag="1"]')).not.toHaveClass(/is-active/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });
});

test("a missing image shows only the names list; a tag with a null rect says 'no area marked'", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openPerson(page);
  await ready(page, 0);
  const fig = figure(page, 3);
  await fig.scrollIntoViewIfNeeded();
  await expect(fig.locator(".gallery-photo--missing")).toBeVisible();
  await expect(fig.locator("button.photo-tags__name")).toHaveText(["Sibling Example", "Spouse Example"]);
  expect(await fig.locator(".photo-tags__layer, .photo-tags__region").count()).toBe(0);
  await fig.locator("button.photo-tags__name").nth(1).click();
  await expect(fig.locator(".photo-tags__panel").nth(1)).toContainText("no area marked");
  await fig.locator("button.photo-tags__name").nth(0).click();
  await expect(fig.locator(".photo-tags__panel").nth(0)).toContainText("center · 25% from the left, 25% from the top, 50% wide, 50% tall");
});

test("text only: <img onerror> in a name, attribute, note and citation creates no element and runs no script", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await openPerson(page);
  await ready(page, 4);
  const fig = figure(page, 4);
  await fig.locator("button.photo-tags__name").hover();
  const card = fig.locator('[role="tooltip"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText(EVIL);
  await fig.locator("button.photo-tags__name").click();
  await expect(fig.locator(".photo-tags__panel")).toContainText(EVIL);
  expect(await fig.locator(".photo-tags__names img, .photo-tags__block img, .photo-tags__layer img, [class*='photo-tags'] img").count()).toBe(0);
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  expect(await fig.locator(".photo-tags__region .photo-tags__label").first().textContent()).toBe(EVIL);
  // the same values in the lightbox
  await fig.locator("button.media-lightbox-trigger").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#mediaLightboxImage")).toBeVisible();
  await expect(page.locator("#mediaLightbox a.photo-tags__region")).toHaveCount(1);
  await expect(page.locator("#mediaLightbox .photo-tags__name")).toHaveText(EVIL);
  expect(await page.locator('#mediaLightbox img[src="x"]').count()).toBe(0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(errors).toEqual([]);
});

for (const [name, viewport] of [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 900 }]]) {
  test(`${name}: lightbox regions are links within 1px of the contained box; names list under the caption; toggle; next photo re-renders`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPerson(page);
    await ready(page, 0);
    await figure(page, 0).locator("button.media-lightbox-trigger").click({ position: { x: 5, y: 5 } });
    const img = page.locator("#mediaLightboxImage");
    await expect(img).toBeVisible();
    const regions = page.locator("#mediaLightbox a.photo-tags__region");
    await expect(regions).toHaveCount(2);
    await expect.poll(async () => { const r = await misfit(page, "#mediaLightbox .lightbox-image-wrapper", "#mediaLightboxImage", RECTS[0]); return r.missing ? 99 : r.worst; }).toBeLessThan(1);
    // DOM order is top to bottom: Father (y 15) before Spouse (y 20); each links to the person's page
    await expect(regions.nth(0)).toHaveAttribute("href", "/person/?id=I9012");
    await expect(regions.nth(0)).toHaveAttribute("aria-label", "Father Example, parent. open their page");
    await expect(regions.nth(1)).toHaveAttribute("href", "/person/?id=I9002");
    await expect(regions.nth(1)).toHaveAttribute("aria-label", "Spouse Example, spouse. open their page");
    // names list under the caption, the image points at it
    expect(await page.evaluate(() => document.getElementById("mediaLightboxCaption").nextElementSibling.querySelector("ul.photo-tags__names") !== null)).toBe(true);
    await expect(page.locator("#mediaLightbox .photo-tags__name")).toHaveText(["Spouse Example", "Father Example", "Child Example"]);
    expect(await img.getAttribute("aria-describedby")).toBe(await page.locator("#mediaLightbox ul.photo-tags__names").getAttribute("id"));
    // the names toggle: 44px, off for a fine pointer (hover shows labels), on for a coarse one
    const toggle = page.locator("#mediaLightbox button.photo-tags__toggle");
    await expect(toggle).toHaveText("names");
    expect((await toggle.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(regions.nth(0).locator(".photo-tags__label")).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(regions.nth(0).locator(".photo-tags__label")).toBeVisible();
    await expect(regions.nth(1).locator(".photo-tags__label")).toBeVisible();
    expect((await regions.nth(0).locator(".photo-tags__label").boundingBox()).height).toBeGreaterThanOrEqual(44);
    // labels stay inside the image and do not cover each other
    const labels = await page.evaluate(() => {
      const r = (e) => e.getBoundingClientRect();
      const im = r(document.getElementById("mediaLightboxImage"));
      const ls = [...document.querySelectorAll("#mediaLightbox .photo-tags__label")].map(r);
      return { inside: ls.every((l) => l.left >= im.left - 1 && l.right <= im.right + 1 && l.top >= im.top - 1 && l.bottom <= im.bottom + 1), overlap: ls.length > 1 && !(ls[0].bottom <= ls[1].top + 0.5 || ls[1].bottom <= ls[0].top + 0.5 || ls[0].right <= ls[1].left + 0.5 || ls[1].right <= ls[0].left + 0.5) };
    });
    expect(labels).toEqual({ inside: true, overlap: false });
    // next photo (portrait): re-rendered for the new image, the names state carries over
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#mediaLightboxCounter")).toHaveText("2 of 6");
    await expect(regions).toHaveCount(1);
    await expect(regions.nth(0)).toHaveAttribute("aria-label", "Test Person (synthetic), this person. open their page");
    await expect.poll(async () => { const r = await misfit(page, "#mediaLightbox .lightbox-image-wrapper", "#mediaLightboxImage", RECTS[1]); return r.missing ? 99 : r.worst; }).toBeLessThan(1);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // square, then a photo without tags: the layer, list and toggle go
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#mediaLightboxCounter")).toHaveText("3 of 6");
    await expect(regions).toHaveCount(2);
    await expect.poll(async () => { const r = await misfit(page, "#mediaLightbox .lightbox-image-wrapper", "#mediaLightboxImage", RECTS[2]); return r.missing ? 99 : r.worst; }).toBeLessThan(1);
    for (let k = 0; k < 3; k += 1) await page.keyboard.press("ArrowRight");
    await expect(page.locator("#mediaLightboxCounter")).toHaveText("6 of 6");
    await expect(page.locator("#mediaLightboxImage")).toBeVisible();
    await expect(regions).toHaveCount(0);
    await expect(page.locator("#mediaLightbox ul.photo-tags__names")).toHaveCount(0);
    await expect(toggle).toBeHidden();
    expect(await img.getAttribute("aria-describedby")).toBeNull();
  });
}

test("1280 lightbox: Tab walks the regions in reading order with the DS focus ring; focus shows the label and the card; Esc closes the card, then the lightbox", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPerson(page);
  await ready(page, 0);
  await figure(page, 0).locator("button.media-lightbox-trigger").click({ position: { x: 5, y: 5 } });
  const regions = page.locator("#mediaLightbox a.photo-tags__region");
  await expect(regions).toHaveCount(2);
  await expect.poll(async () => (await misfit(page, "#mediaLightbox .lightbox-image-wrapper", "#mediaLightboxImage", RECTS[0])).worst).toBeLessThan(1);
  // Bootstrap moves focus into the dialog once it has faded in; then Tab walks the controls and, after the prev and next arrows, the regions
  await expect(page.locator("#mediaLightbox")).toBeFocused();
  let guard = 0;
  while (!(await regions.nth(0).evaluate((el) => el === document.activeElement)) && guard < 20) { await page.keyboard.press("Tab"); guard += 1; }
  await expect(regions.nth(0)).toBeFocused();
  await expect(regions.nth(0).locator(".photo-tags__label")).toBeVisible();
  const ring = await regions.nth(0).evaluate((el) => ({ style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth }));
  expect(ring.style).toBe("solid");
  expect(ring.width).toBe("2px");
  const card = page.locator('#mediaLightbox [role="tooltip"]').nth(1); // Father Example is tag 1
  await expect(card).toBeVisible();
  await expect(card).toContainText("Father Example · their portrait");
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(page.locator("#mediaLightbox")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(regions.nth(1)).toBeFocused();
  await expect(page.locator('#mediaLightbox [role="tooltip"]').nth(0)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator("#mediaLightbox")).toBeHidden();
  await expect(page.locator("#mediaLightbox .photo-tags__layer")).toHaveCount(0);
});

test("1280 lightbox: hovering a region shows its label; the names list highlights the region and shows the card", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPerson(page);
  await ready(page, 0);
  await figure(page, 0).locator("button.media-lightbox-trigger").click({ position: { x: 5, y: 5 } });
  const regions = page.locator("#mediaLightbox a.photo-tags__region");
  await expect(regions).toHaveCount(2);
  await expect.poll(async () => (await misfit(page, "#mediaLightbox .lightbox-image-wrapper", "#mediaLightboxImage", RECTS[0])).worst).toBeLessThan(1);
  await regions.nth(1).hover();
  await expect(regions.nth(1).locator(".photo-tags__label")).toBeVisible();
  await expect(regions.nth(0).locator(".photo-tags__label")).toBeHidden();
  await expect(page.locator('#mediaLightbox [role="tooltip"]').nth(0)).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(page.locator('#mediaLightbox [role="tooltip"]').nth(0)).toBeHidden();
  await page.locator("#mediaLightbox button.photo-tags__name").nth(1).hover();
  await expect(regions.nth(0)).toHaveClass(/is-active/);
  await expect(page.locator('#mediaLightbox [role="tooltip"]').nth(1)).toBeVisible();
});

test("an island that loads after the first render still marks the gallery (it reads the person once)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const hits = await openPerson(page, { delayIsland: 1500 });
  await expect(page.locator("#person-media-grid .gallery-item")).toHaveCount(6);
  expect(await page.locator("ul.photo-tags__names").count()).toBe(0);
  await ready(page, 0);
  await expect(figure(page, 0).locator("ul.photo-tags__names")).toBeVisible();
  expect(hits.person).toBe(2);
  expect(hits.island).toBe(1);
});

for (const [name, viewport] of [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 900 }]]) {
  test(`${name}: axe is clean on the gallery (a pinned panel open) and in the lightbox`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPerson(page);
    await ready(page, 0);
    await figure(page, 0).locator("button.photo-tags__name").nth(0).click();
    await expect(figure(page, 0).locator(".photo-tags__panel").nth(0)).toBeVisible();
    await figure(page, 1).scrollIntoViewIfNeeded();
    expect(await axeViolations(page, { include: "#person-media-section" })).toEqual([]);
    expect(await axeViolations(page)).toEqual([]);
    await figure(page, 0).locator("button.media-lightbox-trigger").click({ position: { x: 5, y: 5 } });
    await expect(page.locator("#mediaLightbox a.photo-tags__region")).toHaveCount(2);
    await page.locator("#mediaLightbox button.photo-tags__toggle").click();
    await page.waitForTimeout(400);
    expect(await axeViolations(page, { include: "#mediaLightbox" })).toEqual([]);
  });
}

test("1280 someone outside the page's tree gets no relationship line (the 'family' fallback is not a relationship)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPerson(page);
  await ready(page, 2);
  const fig = figure(page, 2);
  await fig.locator("button.photo-tags__name").nth(0).click(); // Sibling Example: a sibling of this page's person
  await expect(fig.locator(".photo-tags__panel").nth(0).locator(".photo-tags__site")).toHaveText("from this site, not the tag: a sibling of this page's person");
  await fig.locator("button.photo-tags__name").nth(1).click(); // Stranger Example: not in the tree
  const panel = fig.locator(".photo-tags__panel").nth(1);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Stranger Example");
  expect(await panel.locator(".photo-tags__site").count()).toBe(0);
  expect(await fig.locator(".photo-tags__item").nth(1).locator('[role="tooltip"] .photo-tags__site').count()).toBe(0);
});

test("1280 a shown hovercard follows its anchor on scroll and resize", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPerson(page);
  await ready(page, 0);
  const fig = figure(page, 0);
  const name = fig.locator("button.photo-tags__name").nth(0);
  await name.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 250)); // the name sits well inside the viewport, with room for the card below it
  await name.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab"); // keyboard modality: focus-visible
  const card = fig.locator(".photo-tags__item").nth(0).locator('[role="tooltip"]');
  await expect(card).toBeVisible();
  const gap = async () => page.evaluate(() => {
    const b = document.querySelector("#person-media-grid .gallery-item button.photo-tags__name").getBoundingClientRect();
    const c = document.querySelector("#person-media-grid .gallery-item [role=tooltip]:not([hidden])").getBoundingClientRect();
    return { below: Math.abs(c.top - b.bottom), left: Math.abs(c.left - b.left) };
  });
  const before = await gap();
  expect(before.below).toBeLessThan(2);
  await page.evaluate(() => window.scrollBy(0, 60));
  await expect.poll(async () => (await gap()).below).toBeLessThan(2);
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(card).toBeVisible();
  await expect.poll(async () => (await gap()).below).toBeLessThan(2);
  expect((await gap()).left).toBeLessThan(2);
});

test("forced colors and reduced motion: the regions keep a CanvasText border and stop animating", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await openPerson(page);
  await ready(page, 0);
  const got = await page.evaluate(() => {
    const probe = document.createElement("i");
    probe.style.color = "CanvasText";
    document.body.append(probe);
    const text = getComputedStyle(probe).color;
    probe.remove();
    const region = document.querySelector('#person-media-grid .photo-tags__region');
    const cs = getComputedStyle(region);
    return { text, border: cs.borderTopColor, width: cs.borderTopWidth, style: cs.borderTopStyle, transition: cs.transitionDuration };
  });
  expect(got.border).toBe(got.text);
  expect(got.style).toBe("solid");
  expect(parseFloat(got.width)).toBeGreaterThan(0);
  expect(parseFloat(got.transition)).toBe(0);
});

test("a lightbox opened before the island has the person re-reads its roles when the person arrives", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const hits = await openPerson(page, { delayIsland: 600, delayCatchUp: 2500 });
  await expect(page.locator("#person-media-grid .gallery-item")).toHaveCount(6);
  await expect.poll(() => hits.island).toBe(1);
  await expect.poll(() => hits.person).toBe(2); // the island is asking for the person
  await figure(page, 0).locator("button.media-lightbox-trigger").click({ position: { x: 5, y: 5 } });
  const regions = page.locator("#mediaLightbox a.photo-tags__region");
  await expect(regions).toHaveCount(2);
  // DOM order is top to bottom: Father (y 15) first. No person yet, so he reads as "family"; when the island's read lands he is a parent.
  await expect(regions.nth(0)).toHaveAttribute("aria-label", "Father Example, family. open their page");
  await expect(regions.nth(0)).toHaveAttribute("aria-label", "Father Example, parent. open their page");
  await expect(regions.nth(1)).toHaveAttribute("aria-label", "Spouse Example, spouse. open their page");
  await expect(page.locator("#mediaLightbox")).toBeVisible();
});
