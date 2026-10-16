// HFY-TSK-283 (tag-edit-e2e): the photo tagging lightbox in front of the REAL API over the fake store (edit-e2e-bridge.mjs, createEditWorld({ photo: true })).
// The person page's JSON is what the site's build would write from the store: `galleryOf(world)` reads the people who carry the photo and lists them as its
// tags, so a tag that is approved (or saved) shows on the next page load, as it does after the site is rebuilt. Synthetic ids and placeholder names only.
import { expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { attach } from "./edit-e2e-bridge.mjs";

export { createEditWorld } from "./edit-e2e-bridge.mjs";
const LEGACY = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
export const PAGE = { id: "I0003", url: "/person/?id=I0003" }; // the woman whose page shows the photo
const SIZE = [800, 600];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE[0]}" height="${SIZE[1]}"><rect width="${SIZE[0]}" height="${SIZE[1]}" fill="gray"/></svg>`;
const PEOPLE = [{ grampsId: "I0001", displayName: "Alder Testwood" }, { grampsId: "I0003", displayName: "Hazel Birchwell" }, { grampsId: "I0006", displayName: "Briar Testwood" }];
const FLAGS = { photoTags: true, photoTagEdit: true, recordEdit: true, proposalReview: true };

/** The tags of the world's photo, as the site would list them: one per MediaRef in a person's media_list that points at it. */
export function galleryOf(world) {
  const tags = [];
  for (const p of [world.me, world.mother, world.kid]) {
    const stored = world.stored("Person", p.handle);
    for (const m of stored.media_list || []) {
      if (m.ref !== world.pic.handle) continue;
      tags.push({ grampsId: stored.gramps_id, name: PEOPLE.find((x) => x.grampsId === stored.gramps_id).displayName, rect: m.rect, isPrimary: false, attributes: [], notes: [], citations: [], source: "gramps" });
    }
  }
  return [{ handle: world.pic.handle, mime: "image/jpeg", title: "A synthetic photo", grampsId: world.pic.gramps_id, tags }];
}

/** A page acting as `id`, with the person page, the media and the picker's people index in place. Returns { page, ctx, log }. */
export async function member(browser, world, id, viewport = { width: 375, height: 812 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const log = await attach(page, world, { id, label: PEOPLE.find((x) => x.grampsId === id)?.displayName || "Example" }, { flags: FLAGS });
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: PEOPLE } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: PEOPLE.map((p) => ({ grampsId: p.grampsId, searchText: p.displayName.toLowerCase() })) } }));
  await page.route(`**/person/${PAGE.id}.json`, (r) => r.fulfill({ json: { ...LEGACY, grampsId: PAGE.id, handle: world.mother.handle, displayName: "Hazel Birchwell", primaryPhoto: undefined, mediaGallery: galleryOf(world) } }));
  await page.route("**/media/tree_*.svg", (r) => r.fulfill({ contentType: "image/svg+xml", body: readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8") }));
  await page.route(/\/media\/[0-9a-f]{28}\.jpg/, (r) => r.fulfill({ contentType: "image/svg+xml", body: svg }));
  return { page, ctx, log };
}

export const toggle = (page) => page.locator("#mediaLightbox button.photo-tag-edit__toggle");
export const layer = (page) => page.locator("#mediaLightbox [data-hfy-tag-layer]");
export const panel = (page) => page.locator("#mediaLightbox [data-hfy-tag-panel]");
export const sheet = (page) => page.locator("#mediaLightbox dialog.hfy-sheet");
export const regions = (page) => layer(page).locator("button.photo-tag-edit__region");
export const names = (page) => page.locator("#mediaLightbox ul.photo-tags__names .photo-tags__name");

/** Open the person page and its photo in the lightbox (tagging off). */
export async function openPhoto(page) {
  await page.goto(PAGE.url, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-hero h1")).toHaveText("Hazel Birchwell");
  const fig = page.locator("#person-media-grid .gallery-item").first();
  await fig.scrollIntoViewIfNeeded();
  await fig.locator("button.media-lightbox-trigger").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#mediaLightboxImage")).toBeVisible();
}
/** ... and switch tagging on. */
export async function startTagging(page) {
  await openPhoto(page);
  await expect(toggle(page)).toBeVisible();
  await toggle(page).click();
  await expect(layer(page)).toBeVisible();
}

const pictureBox = (page) => page.evaluate(() => {
  const img = document.getElementById("mediaLightboxImage");
  const r = img.getBoundingClientRect();
  const s = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
  const w = img.naturalWidth * s;
  const h = img.naturalHeight * s;
  return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h };
});
/** Draw a box on the photo from one point to another (percent of the photo). */
export async function draw(page, from, to) {
  const b = await pictureBox(page);
  const at = ([px, py]) => [b.x + (px / 100) * b.w, b.y + (py / 100) * b.h];
  const [x1, y1] = at(from);
  const [x2, y2] = at(to);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 });
  await page.mouse.move(x2, y2, { steps: 4 });
  await page.mouse.up();
}
export async function pickPerson(page, typed, name) {
  await panel(page).getByRole("combobox").fill(typed);
  await panel(page).getByRole("option", { name: new RegExp(name) }).click();
}
