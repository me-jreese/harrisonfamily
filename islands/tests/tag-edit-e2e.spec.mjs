// HFY-TSK-283 (tag-edit-e2e, flag photoTagEdit), the three scenarios replayed on the kit editor (HFY-TSK-388-0G pass 2), end to end in a real browser against the REAL API
// over the fake store (tag-e2e-bridge.mjs). A tag drawn on another person becomes a suggestion; an admin approves it in the review queue; it is in the overlay on the next
// load. A tag of oneself on one's own record saves now, and "remove me from this photo" takes it off again. A stale tag is a conflict and never moves another rectangle.
// Same user actions as the shipped editor's scenarios, except the undo: the kit's undo belongs to a removal, so scenario 2 undoes through self-untag.
// Synthetic people only. Runs on localhost against the committed site:
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/tag-edit-e2e.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { ADMIN, ME } from "../../api/test/edit-e2e-world.js";
import { createEditWorld, editor, member, names, openPhoto, pickPerson, rows, startTagging, tap } from "./tag-e2e-bridge.mjs";

test.use({ viewport: { width: 375, height: 812 } });

let world;
test.beforeEach(async () => { world = await createEditWorld({ photo: true }); });
test.afterEach(() => world.dispose());

const mediaRefs = (p) => (world.stored("Person", p.handle).media_list || []).filter((m) => m.ref === world.pic.handle);
const realCalls = (log) => log.filter((e) => e.method === "POST" && e.path === "/api/changes");

test("scenario 1: a tag drawn on another person becomes a suggestion, an admin approves it, and it is in the overlay", async ({ browser }) => {
  const { page, ctx, log } = await member(browser, world, ME);
  await startTagging(page);
  await expect(rows(page)).toHaveCount(1); // the woman, tagged before
  await tap(page, 70, 70);
  await pickPerson(page, "briar", "Briar Testwood");
  await editor(page).getByRole("button", { name: "done" }).click();
  await expect.poll(() => realCalls(log).length).toBe(1);
  // a suggestion, not a tag: the child's record is as it was and the page shows nothing new
  expect(mediaRefs(world.kid)).toEqual([]);
  expect(world.version("Person", world.kid.handle)).toBe(1);
  expect(world.rows("PROP#").length).toBeGreaterThan(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openPhoto(page);
  await expect(names(page)).toHaveText(["Hazel Birchwell"]);
  await ctx.close();

  const admin = await member(browser, world, ADMIN);
  await admin.page.goto("/me/review/", { waitUntil: "domcontentloaded" });
  await expect(admin.page.locator("[data-hfy-review-ready]")).toBeVisible();
  await admin.page.locator("[data-hfy-items] > li").first().getByRole("button").click();
  const approve = admin.page.locator('[data-hfy-proposal-card] [data-hfy-act="approve"]');
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(admin.page.locator("[data-hfy-proposal-card]")).toHaveAttribute("data-state", "approved");
  await admin.ctx.close();

  // approved: the child's record carries the tag with a whole-percent rect, and the overlay shows it
  expect(mediaRefs(world.kid)).toHaveLength(1);
  expect(mediaRefs(world.kid)[0].rect.every(Number.isInteger)).toBe(true);
  const again = await member(browser, world, ME);
  await startTagging(again.page);
  await expect(rows(again.page)).toHaveCount(2);
  // the editor draws the photo while it is open: the view layer's boxes are in the page but hidden (photo-tag-edit-on)
  await expect(again.page.locator("#mediaLightbox a.photo-tags__region")).toHaveCount(2);
  for (const i of [0, 1]) await expect(again.page.locator("#mediaLightbox a.photo-tags__region").nth(i)).toBeHidden();
  await again.page.locator("#mediaLightbox section.io-media-tags").getByRole("button", { name: "done" }).click();
  for (const i of [0, 1]) await expect(again.page.locator("#mediaLightbox a.photo-tags__region").nth(i)).toBeVisible();
  await expect(names(again.page)).toHaveText(["Hazel Birchwell", "Briar Testwood"]);
  await again.ctx.close();
});

test("scenario 2: a tag on my own record saves now, and 'remove me from this photo' takes it off again", async ({ browser }) => {
  const { page, ctx, log } = await member(browser, world, ME);
  await startTagging(page);
  await tap(page, 70, 70);
  await pickPerson(page, "alder", "Alder Testwood");
  await editor(page).getByRole("button", { name: "add a box in the middle" }).click(); // commits the box, opens another
  await page.getByRole("dialog", { name: "who is this?" }).getByRole("button", { name: "cancel" }).click();
  await expect.poll(() => realCalls(log).length).toBe(1);
  expect(mediaRefs(world.me)).toHaveLength(1);
  expect(world.version("Person", world.me.handle)).toBe(2);
  expect(world.rows("PROP#")).toEqual([]); // nothing went to review
  await expect(rows(page)).toHaveCount(2);
  // the member's own row has the self-untag control, the woman's does not
  await expect(editor(page).getByRole("button", { name: "remove me from this photo" })).toHaveCount(1);
  await editor(page).getByRole("button", { name: "remove me from this photo" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "remove me" }).click();
  await expect.poll(() => realCalls(log).length).toBe(2);
  await expect(editor(page).locator(".io-media-toast").getByText("you are removed from this photo.")).toBeVisible();
  expect(mediaRefs(world.me)).toEqual([]);
  expect(world.version("Person", world.me.handle)).toBe(3);
  expect(world.rows("PROP#")).toEqual([]);
  await expect(rows(page)).toHaveCount(1);
  // the woman's tag was never touched
  expect(mediaRefs(world.mother)).toHaveLength(1);
  expect(world.version("Person", world.mother.handle)).toBe(1);
  await ctx.close();
});

test("scenario 3: a stale tag is a conflict and never moves another rectangle", async ({ browser }) => {
  const { page, ctx, log } = await member(browser, world, ME);
  await startTagging(page);
  // Somebody (a Gramps sync) moves the tag after this page was built.
  const moved = JSON.parse(JSON.stringify(world.stored("Person", world.mother.handle)));
  moved.media_list[0].rect = [12, 12, 42, 42];
  await world.bump(moved, world.version("Person", world.mother.handle));
  await editor(page).getByRole("button", { name: "edit box, Hazel Birchwell" }).click();
  await editor(page).getByRole("button", { name: "move right" }).click();
  await editor(page).getByRole("button", { name: "done" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "someone else changed this photo" })).toBeVisible();
  expect(realCalls(log)).toEqual([]);
  expect(mediaRefs(world.mother)[0].rect).toEqual([12, 12, 42, 42]);
  expect(world.rows("PROP#")).toEqual([]);
  await ctx.close();
});
