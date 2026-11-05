// HFY-TSK-308 (viz-v2-faces-tab): the faces tab of /tree/ behind familyVizFaces. Hermetic: /_data/flags.json, /auth/session, /person/graph.json,
// the gated person JSON, the face crops and the photos are route-stubbed with synthetic data (invented names, generated SVG images).
//   HFY_SITE=<dir> PW_PORT=<port> PW_CHANNEL=chromium-headless-shell npx playwright test tests/tree-faces-tab.spec.mjs --workers=1
// HFY_SHOTS_DIR=<dir> also saves the D-11 audit screenshots (375, 768, 1280), the evidence for the flip task (HFY-R16 asset prefix).
import { test, expect } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const SMALL = JSON.parse(readFileSync(new URL("./fixtures/tree-graph-small.json", import.meta.url), "utf8"));
const FACES = { I9003: "faces/I9003-0123abcd.webp", I9004: "faces/I9004-1123abcd.webp", I9002: null };
const EDGES = [
  { media: "O1", people: ["I9002", "I9003", "I9004"] },
  { media: "O2", people: ["I9003", "I9004"] },
  { media: "O3", people: ["I9001", "I9002"] }
];
const graphBody = JSON.stringify({ ...SMALL, photoEdges: EDGES, people: SMALL.people.map((p) => (p.id in FACES ? { ...p, face: FACES[p.id] } : p)) });
const svg = (w, h, fill) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${fill}"/></svg>`;
const TAGS = [
  { grampsId: "I9003", name: "Ada Example", rect: [10, 20, 40, 60], isPrimary: false, attributes: [], notes: [], citations: [], source: "gramps" },
  { grampsId: "I9004", name: "Bram Example", rect: [55, 20, 90, 60], isPrimary: false, attributes: [], notes: [], citations: [], source: "gramps" }
];
const PERSON = { grampsId: "I9003", mediaGallery: [{ handle: "MF1", mime: "image/jpeg", title: "Synthetic group", grampsId: "O1", tags: TAGS }] };

async function open(page, { width = 1280, height = 1000, faces = true, view = "faces" } = {}) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, familyViz: true, familyVizFaces: faces } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: "I9003", label: "Ada Example" } }));
  await page.route("**/person/graph.json", (r) => r.fulfill({ status: 200, contentType: "application/json", body: graphBody }));
  await page.route("**/person/I9002.json", (r) => r.fulfill({ status: 404, body: "" }));
  await page.route(/\/person\/I9003\.json/, (r) => r.fulfill({ json: PERSON }));
  await page.route("**/media/faces/**", (r) => r.fulfill({ contentType: "image/svg+xml", body: svg(160, 160, "#888888") }));
  await page.route("**/media/MF1.jpg", (r) => r.fulfill({ contentType: "image/svg+xml", body: svg(400, 300, "#aaaaaa") }));
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width, height });
  await page.goto(`/tree/?focus=I9003&view=${view}${faces ? "&hfy_flags=familyVizFaces" : ""}`, { waitUntil: "domcontentloaded" });
  return errors;
}
const tab = (page) => page.locator("[data-tree-faces]");

test("flag off: no faces button, and ?view=faces reads as the cards", async ({ page }) => {
  await open(page, { faces: false });
  await expect(page.locator("[data-tree-focus]")).toBeVisible();
  await expect(page.locator("[data-tree-view='faces']")).toHaveCount(0);
  await expect(tab(page)).toHaveCount(0);
});

test("one group per photo, in order; null face is initials, a crop is an img", async ({ page }) => {
  const errors = await open(page);
  await expect(tab(page)).toBeVisible();
  await expect(tab(page).locator("[data-faces-group]")).toHaveCount(3);
  await expect(tab(page).locator("[data-faces-group='O1'] [data-faces-face]")).toHaveCount(3);
  await expect(tab(page).locator("[data-faces-group='O1'] [data-faces-face='I9002'] [data-faces-initials]")).toHaveText("HS");
  await expect(tab(page).locator("[data-faces-group='O1'] [data-faces-face='I9003'] img")).toHaveAttribute("src", "/media/faces/I9003-0123abcd.webp");
  await expect(tab(page).locator("[data-faces-group='O1'] a.hfy-person-name").first()).toHaveAttribute("href", /\/person\/\?id=/);
  expect(errors).toEqual([]);
});

test("choosing a face highlights every photo that person is in; choosing it again clears", async ({ page }) => {
  await open(page);
  await tab(page).locator("[data-faces-face='I9002']").first().click();
  await expect(tab(page).locator("[data-faces-status]")).toHaveText("Hana Sample is in 2 photos.");
  await expect(tab(page).locator("[data-faces-group][data-hit='true']")).toHaveCount(2);
  await expect(tab(page).locator("[data-faces-group='O2']")).toHaveAttribute("data-hit", "false");
  await tab(page).locator("[data-faces-face='I9002']").first().click();
  await expect(tab(page).locator("[data-faces-group][data-hit='true']")).toHaveCount(0);
});

test("opening a photo draws surf-photo-tags-ui's regions and names list; a missing photo says so", async ({ page }) => {
  await open(page);
  await tab(page).locator("[data-faces-open='O1']").click();
  const viewer = tab(page).locator("[data-faces-viewer='O1']");
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".photo-tags__layer .photo-tags__region")).toHaveCount(2);
  await expect(tab(page).locator("[data-faces-group='O1'] .photo-tags__names .photo-tags__item")).toHaveCount(2);
  await tab(page).locator("[data-faces-open='O2']").click();
  await expect(tab(page).locator("[data-faces-viewer-failed]")).toBeVisible();
});

test("375: the mosaic is two columns, and 'people in this photo' outlines the regions on tap", async ({ page }) => {
  await open(page, { width: 375, height: 812 });
  const cols = await tab(page).locator("[data-faces-group='O1'] .hfy-faces__grid").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  expect(cols).toBe(2);
  await tab(page).locator("[data-faces-open='O1']").click();
  const viewer = tab(page).locator("[data-faces-viewer='O1']");
  await expect(viewer.locator(".photo-tags__region")).toHaveCount(2);
  const ringAt = (i) => viewer.locator(".photo-tags__region").nth(i).evaluate((el) => getComputedStyle(el).borderTopColor);
  expect(await ringAt(0)).toBe("rgba(0, 0, 0, 0)");
  await viewer.locator("[data-faces-outline]").tap().catch(() => viewer.locator("[data-faces-outline]").click());
  await expect(viewer.locator("[data-faces-outline]")).toHaveAttribute("aria-pressed", "true");
  expect(await ringAt(0)).not.toBe("rgba(0, 0, 0, 0)");
  await expect(viewer.locator(".photo-tags__layer--names")).toHaveCount(1);
});

test("at most 24 faces are requested in the first view", async ({ page }) => {
  const asked = [];
  page.on("request", (r) => { if (r.url().includes("/media/faces/")) asked.push(r.url()); });
  await open(page);
  await expect(tab(page)).toBeVisible();
  await page.waitForTimeout(300);
  expect(asked.length).toBeLessThanOrEqual(24);
  expect(asked.length).toBeGreaterThan(0);
});

for (const [width, height] of [[375, 812], [768, 1024], [1280, 900]]) {
  test(`D-11 audit at ${width}px with ?hfy_flags=familyVizFaces: axe, 44 px targets, 16 px names, no sideways scroll`, async ({ page }) => {
    await open(page, { width, height });
    await expect(tab(page)).toBeVisible();
    await tab(page).locator("[data-faces-face='I9004']").first().click();
    await tab(page).locator("[data-faces-open='O1']").click();
    await expect(tab(page).locator("[data-faces-viewer='O1'] .photo-tags__region")).toHaveCount(2);
    if (process.env.HFY_SHOTS_DIR) {
      mkdirSync(process.env.HFY_SHOTS_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.HFY_SHOTS_DIR}/tree-faces-${width}.png`, fullPage: true });
    }
    expect(await axeViolations(page)).toEqual([]);
    const small = await tab(page).locator(":is(a, button)").evaluateAll((els) => els
      .filter((e) => e.getClientRects().length && !e.closest(".photo-tags__layer"))  // the regions are the photo's own marks, sized by the tag
      .map((e) => ({ t: e.textContent.trim().slice(0, 24), r: e.getBoundingClientRect() }))
      .filter((x) => x.r.height < 44 || x.r.width < 44));
    expect(small).toEqual([]);
    const names = await tab(page).locator(".hfy-faces__name").evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
    expect(names.length).toBeGreaterThan(0);
    expect(Math.min(...names)).toBeGreaterThanOrEqual(16);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

for (const width of [320, 375]) {
  test(`${width}: no horizontal page scroll with a photo open`, async ({ page }) => {
    await open(page, { width, height: 700 });
    await tab(page).locator("[data-faces-open='O1']").click();
    await expect(tab(page).locator("[data-faces-viewer='O1'] .photo-tags__region")).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
