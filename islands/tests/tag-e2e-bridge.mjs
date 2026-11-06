// HFY-TSK-283 (tag-edit-e2e), rewritten for the kit editor (HFY-TSK-388-0G pass 2): the person page's tagging lightbox in front of the REAL API over the fake store
// (edit-e2e-bridge.mjs, createEditWorld({ photo: true })). The person page's JSON is what the site's build would write from the store (`galleryOf`), so a tag that is
// approved shows on the next page load. The kit editor reads the photo through GET /api/media/:id and its Media handle through GET /api/edit/Media/:id; the world has
// neither, so both are answered here from the world's store (`mediaDetailOf`); every write goes to the real /api/changes. Synthetic ids and placeholder names only.
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
const nameOf = (id) => PEOPLE.find((x) => x.grampsId === id)?.displayName || "Example";

/** The tags of the world's photo, as the site would list them: one per MediaRef in a person's media_list that points at it. */
// Limit: this is a hand-built stand-in for the site's build output; it proves the store holds the approved tag, not that the real build emits it.
export function galleryOf(world) {
  const tags = [];
  for (const p of [world.me, world.mother, world.kid]) {
    const stored = world.stored("Person", p.handle);
    for (const m of stored.media_list || []) {
      if (m.ref !== world.pic.handle) continue;
      tags.push({ grampsId: stored.gramps_id, name: nameOf(stored.gramps_id), rect: m.rect, isPrimary: false, attributes: [], notes: [], citations: [] });
    }
  }
  return [{ handle: world.pic.handle, mime: "image/jpeg", title: "A synthetic photo", grampsId: world.pic.gramps_id, tags }];
}

/** GET /api/media/:id for the world's photo: a tag per MediaRef (index = place in media_list), the version a function of the people's versions. */
export function mediaDetailOf(world) {
  const tags = [];
  const versions = [];
  for (const p of [world.me, world.mother, world.kid]) {
    const stored = world.stored("Person", p.handle);
    versions.push(`${stored.gramps_id}:${world.version("Person", p.handle)}`);
    (stored.media_list || []).forEach((m, index) => { if (m.ref === world.pic.handle) tags.push({ personId: stored.gramps_id, mediaId: world.pic.gramps_id, rect: m.rect, index, state: "applied", person: { displayName: nameOf(stored.gramps_id), living: false } }); });
  }
  return { card: { mediaId: world.pic.gramps_id, thumbUrl: `/media/${world.pic.handle}.jpg`, width: SIZE[0], height: SIZE[1], section: "media", tagCount: tags.length, needsTags: false, title: "A synthetic photo" }, imageUrl: `/media/${world.pic.handle}.jpg`, origin: "gramps", tags, version: versions.join("|"), handle: world.pic.handle };
}

/** A page acting as `id`, with the person page, the media and the picker's people index in place. Returns { page, ctx, log }. */
export async function member(browser, world, id, viewport = { width: 375, height: 812 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const log = await attach(page, world, { id, label: nameOf(id) }, { flags: FLAGS });
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: PEOPLE.map((p) => ({ ...p, living: false })) } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: PEOPLE.map((p) => ({ grampsId: p.grampsId, searchText: p.displayName.toLowerCase() })) } }));
  await page.route(/\/api\/media\/[^/?]+(\?.*)?$/, (r) => r.fulfill({ json: mediaDetailOf(world) }));
  await page.route(/\/api\/edit\/Media\/[^/?]+$/, (r) => r.fulfill({ json: { key: `Media:${world.pic.handle}`, version: 1, obj: { _class: "Media", handle: world.pic.handle, gramps_id: world.pic.gramps_id } } }));
  await page.route(`**/person/${PAGE.id}.json`, (r) => r.fulfill({ json: { ...LEGACY, grampsId: PAGE.id, handle: world.mother.handle, displayName: "Hazel Birchwell", primaryPhoto: undefined, mediaGallery: galleryOf(world) } }));
  await page.route("**/media/tree_*.svg", (r) => r.fulfill({ contentType: "image/svg+xml", body: readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8") }));
  await page.route(/\/media\/[0-9a-f]{28}\.jpg/, (r) => r.fulfill({ contentType: "image/svg+xml", body: svg }));
  return { page, ctx, log };
}

export const toggle = (page) => page.locator("#mediaLightbox button.hfy-tag-toggle");
export const editor = (page) => page.locator("#mediaLightbox section.io-media-tags");
export const rows = (page) => editor(page).locator("ul.io-media-list li");
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
  await expect(editor(page).locator(".io-media-stage")).toBeVisible();
  await expect(rows(page).first()).toBeVisible();
}

async function at(page, px, py) {
  const b = await editor(page).locator(".io-media-stage").boundingBox();
  return [b.x + (px / 100) * b.width, b.y + (py / 100) * b.height];
}
/** Tap the photo (percent of it): the kit places a default box there. */
export async function tap(page, px, py) {
  const [x, y] = await at(page, px, py);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}
export async function pickPerson(page, typed, name) {
  const sheet = page.getByRole("dialog", { name: "who is this?" });
  await sheet.getByRole("combobox").fill(typed);
  await sheet.getByRole("option", { name: new RegExp(name) }).click();
}
