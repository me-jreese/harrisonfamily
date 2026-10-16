// HFY-TSK-283 (tag-edit-e2e, flag photoTagEdit): the photo tagging scenarios end to end in a real browser against the REAL API over the fake store
// (tag-e2e-bridge.mjs). A tag drawn on another person becomes a suggestion; an admin approves it in the review queue; it is in the overlay on the next load.
// A tag of oneself on one's own record saves now, and removing it takes it off again. A stale tag key is a conflict and never moves another rectangle.
// Synthetic people only. Runs on localhost against the committed site:
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/tag-edit-e2e.spec.mjs
import { test, expect } from "@playwright/test";
import { ADMIN, ME } from "../../api/test/edit-e2e-world.js";
import { createEditWorld, draw, member, names, panel, pickPerson, regions, sheet, startTagging, openPhoto, toggle } from "./tag-e2e-bridge.mjs";

test.use({ viewport: { width: 375, height: 812 } });

let world;
test.beforeEach(async () => { world = await createEditWorld({ photo: true }); });
test.afterEach(() => world.dispose());

const mediaRefs = (p) => (world.stored("Person", p.handle).media_list || []).filter((m) => m.ref === world.pic.handle);
const realCalls = (log) => log.filter((e) => e.method === "POST" && e.path === "/api/changes" && !e.body.dry_run);

test("scenario 1: a tag drawn on another person becomes a suggestion, an admin approves it, and it is in the overlay", async ({ browser }) => {
  const { page, ctx, log } = await member(browser, world, ME);
  await startTagging(page);
  await expect(regions(page)).toHaveCount(1); // the woman, tagged before
  await draw(page, [50, 50], [80, 80]);
  await pickPerson(page, "briar", "Briar Testwood");
  await expect(panel(page).locator("[data-hfy-tag-route]")).toHaveAttribute("data-hfy-tag-route", "review");
  await panel(page).locator("[data-hfy-tag-save]").click();
  await expect(sheet(page).locator("[data-hfy-group='hfy-sheet-review']")).toContainText("tag Briar Testwood in this photo");
  await expect(sheet(page).locator("[data-hfy-group='hfy-sheet-direct']")).toHaveCount(0);
  await sheet(page).locator("[data-hfy-save]").click();
  await expect(panel(page).locator("[data-hfy-tag-toast]")).toContainText("sent for review");
  // a suggestion, not a tag: the child's record is as it was and the page shows nothing new
  expect(mediaRefs(world.kid)).toEqual([]);
  expect(world.version("Person", world.kid.handle)).toBe(1);
  expect(realCalls(log)).toHaveLength(1);
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
  const rect = mediaRefs(world.kid)[0].rect;
  expect(rect.every(Number.isInteger)).toBe(true);
  const again = await member(browser, world, ME);
  await startTagging(again.page);
  await expect(regions(again.page)).toHaveCount(2);
  await expect(again.page.locator("#mediaLightbox a.photo-tags__region")).toHaveCount(2);
  await toggle(again.page).click();
  await expect(names(again.page)).toHaveText(["Hazel Birchwell", "Briar Testwood"]);
  await again.ctx.close();
});

test("scenario 2: a tag on my own record saves now, and the toast's undo takes it off again", async ({ browser }) => {
  const { page, ctx, log } = await member(browser, world, ME);
  await startTagging(page);
  await draw(page, [50, 50], [80, 80]);
  await pickPerson(page, "alder", "Alder Testwood");
  await expect(panel(page).locator("[data-hfy-tag-route]")).toHaveAttribute("data-hfy-tag-route", "direct");
  await panel(page).locator("[data-hfy-tag-save]").click();
  await expect(sheet(page).locator("[data-hfy-group='hfy-sheet-direct']")).toContainText("tag Alder Testwood in this photo");
  await expect(sheet(page).locator("[data-hfy-group='hfy-sheet-review']")).toHaveCount(0);
  await sheet(page).locator("[data-hfy-save]").click();
  await expect(panel(page).locator("[data-hfy-tag-toast]")).toHaveText("saved. the tag is on the photo.");
  expect(mediaRefs(world.me)).toHaveLength(1);
  expect(world.version("Person", world.me.handle)).toBe(2);
  expect(world.rows("PROP#")).toEqual([]); // nothing went to review
  expect(realCalls(log)).toHaveLength(1);
  // the overlay has it without a reload
  await expect(regions(page)).toHaveCount(2);
  // undo: the toast's button sends the inverse ops the save returned, and the tag is off again
  const undo = panel(page).locator("[data-hfy-tag-undo]");
  await expect(undo).toBeVisible();
  await expect(undo).toHaveText("undo");
  await undo.click();
  await expect(panel(page).locator("[data-hfy-tag-toast]")).toHaveText("undone. the tags are as they were.");
  await expect(undo).toHaveCount(0);
  expect(mediaRefs(world.me)).toEqual([]);
  expect(world.version("Person", world.me.handle)).toBe(3);
  expect(realCalls(log)).toHaveLength(2);
  expect(world.rows("PROP#")).toEqual([]);
  await expect(regions(page)).toHaveCount(1);
  // the woman's tag was never touched
  expect(mediaRefs(world.mother)).toHaveLength(1);
  expect(world.version("Person", world.mother.handle)).toBe(1);
  await ctx.close();
});

test("scenario 3: a stale tag key is a conflict and never moves another rectangle", async ({ browser }) => {
  const { page, ctx, log } = await member(browser, world, ME);
  await startTagging(page);
  // Somebody (a Gramps sync) moves the tag after this page was built.
  const moved = JSON.parse(JSON.stringify(world.stored("Person", world.mother.handle)));
  moved.media_list[0].rect = [12, 12, 42, 42];
  await world.bump(moved, world.version("Person", world.mother.handle));
  await regions(page).first().click();
  await panel(page).locator("[data-hfy-tag-nudge] [data-move='right']").click();
  await panel(page).locator("[data-hfy-tag-save]").click();
  await expect(sheet(page).locator("[data-hfy-problem]")).toContainText("this tag changed while you were looking");
  expect(realCalls(log)).toEqual([]);
  expect(mediaRefs(world.mother)[0].rect).toEqual([12, 12, 42, 42]);
  expect(world.rows("PROP#")).toEqual([]);
  await ctx.close();
});
