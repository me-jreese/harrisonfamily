// HFY-TSK-283 (tag-edit-e2e): the D-11 after-state audit for the photo tagging lightbox (flag photoTagEdit) at 375 and 1024 px, against the real API over the
// fake store (tag-e2e-bridge.mjs). Every state is measured with the same checklist as the editing audit (d11-measure.mjs): 16 px inputs, 44 px targets, one
// control height per row, no horizontal scroll, axe (serious and critical) clean. The tagging-specific checks are explicit: the four corner handles and every
// nudge button are 44 px, and every one has a name. The installed-iPhone PWA pass is io's UAT inside tag-edit-flip, not here.
// With HFY_AUDIT_SHOTS=<dir> each state is also saved as a screenshot (the audit document links them under the HFY-R16 asset prefix); without it nothing is written.
//   HFY_SITE=<dir> PW_PORT=<port> [HFY_AUDIT_SHOTS=<dir>] npx playwright test tests/tag-edit-d11-audit.spec.mjs
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ME } from "../../api/test/edit-e2e-world.js";
import { axeViolations } from "./axe.mjs";
import { MEASURE } from "./d11-measure.mjs";
import { createEditWorld, draw, layer, member, panel, pickPerson, regions, sheet, startTagging } from "./tag-e2e-bridge.mjs";

const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1024", { width: 1024, height: 768 }]];
const SHOTS = process.env.HFY_AUDIT_SHOTS || "";

async function audit(page, state) {
  const findings = [...(await page.evaluate(`(${MEASURE.toString()})()`)), ...(await axeViolations(page)).map((v) => `axe ${v}`)];
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${state}-${page.viewportSize().width}.png`), fullPage: true });
  }
  expect(findings, `${state} at ${page.viewportSize().width}px`).toEqual([]);
}

/** Every element matching `selector` is at least 44 by 44 px and has an accessible name (counted, so an empty match cannot pass). */
async function targets44(page, selector, count) {
  const found = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => {
    const r = e.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), name: (e.getAttribute("aria-label") || e.textContent || "").trim() };
  }), selector);
  expect(found.length, selector).toBe(count);
  for (const f of found) {
    expect(f.name, selector).not.toBe("");
    expect(f.w, `${f.name} width`).toBeGreaterThanOrEqual(44);
    expect(f.h, `${f.name} height`).toBeGreaterThanOrEqual(44);
  }
}

let world;
test.beforeEach(async () => { world = await createEditWorld({ photo: true }); });
test.afterEach(() => world.dispose());

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test("the tagging lightbox: the layer on, a box with its handles, the picker and nudge buttons, the confirmation sheet", async ({ browser }) => {
      const { page, ctx } = await member(browser, world, ME, viewport);
      await startTagging(page);
      await audit(page, "tag-layer");
      // an existing tag selected: four corner handles, the panel with the nudge buttons
      await regions(page).first().click();
      await expect(layer(page).locator("button.photo-tag-edit__handle")).toHaveCount(4);
      await targets44(page, "#mediaLightbox button.photo-tag-edit__handle", 4);
      await targets44(page, "#mediaLightbox [data-hfy-tag-nudge] button", 12);
      await audit(page, "tag-selected");
      // a new box drawn, the person picker open with matches
      await page.locator("#mediaLightbox [data-hfy-tag-cancel]").click();
      await draw(page, [50, 50], [80, 80]);
      await panel(page).getByRole("combobox").fill("a");
      await expect(panel(page).getByRole("option").first()).toBeVisible();
      await targets44(page, "#mediaLightbox button.photo-tag-edit__handle", 4);
      await audit(page, "tag-picker");
      // the person picked, the confirmation sheet for a tag that goes to review
      await pickPerson(page, "briar", "Briar Testwood");
      await panel(page).locator("[data-hfy-tag-save]").click();
      await expect(sheet(page).locator("[data-hfy-group='hfy-sheet-review']")).toBeVisible();
      await audit(page, "tag-sheet");
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(panel(page).locator("[data-hfy-tag-toast]")).toContainText("sent for review");
      await audit(page, "tag-sent");
      // a tag on one's own record saves now: the toast offers undo, a 44px target
      await draw(page, [50, 50], [80, 80]);
      await pickPerson(page, "alder", "Alder Testwood");
      await panel(page).locator("[data-hfy-tag-save]").click();
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(panel(page).locator("[data-hfy-tag-undo]")).toBeVisible();
      await targets44(page, "#mediaLightbox [data-hfy-tag-undo]", 1);
      await audit(page, "tag-saved-undo");
      await ctx.close();
    });
  });
}
