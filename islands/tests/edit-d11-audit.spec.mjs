// HFY-TSK-282 (edit-e2e-d11-audit): the D-11 after-state audit for /edit/, /edit/family/ and /me/review/ at 375 and 1024 px, against the real API over the
// fake store (edit-e2e-bridge.mjs). Every state of each page is measured for: 16 px inputs, 44 px targets, one control height per row (controls in one flex or grid container), 56 px wizard choices, no horizontal
// scroll, and axe (serious and critical) clean. The installed-iPhone PWA pass is io's UAT inside edit-flag-flip, not here.
// With HFY_AUDIT_SHOTS=<dir> each state is also saved as a screenshot (the audit document links them under the HFY-R16 asset prefix); without it nothing is written.
//   HFY_SITE=<dir> PW_PORT=<port> [HFY_AUDIT_SHOTS=<dir>] npx playwright test tests/edit-d11-audit.spec.mjs
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ADMIN, ME } from "../../api/test/edit-e2e-world.js";
import { attach, createEditWorld } from "./edit-e2e-bridge.mjs";
import { axeViolations } from "./axe.mjs";
import { MEASURE } from "./d11-measure.mjs";

const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1024", { width: 1024, height: 768 }]];
const SHOTS = process.env.HFY_AUDIT_SHOTS || "";

async function audit(page, testInfo, state) {
  const findings = [...(await page.evaluate(`(${MEASURE.toString()})()`)), ...(await axeViolations(page)).map((v) => `axe ${v}`)];
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    const vp = page.viewportSize().width;
    await page.screenshot({ path: join(SHOTS, `${state}-${vp}.png`), fullPage: true });
  }
  expect(findings, `${state} at ${page.viewportSize().width}px`).toEqual([]);
}

let world;
test.beforeEach(async () => { world = await createEditWorld(); });
test.afterEach(() => world.dispose());

async function as(browser, id, viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await attach(page, world, { id, label: "Example" });
  return { page, ctx };
}
const expandAll = async (page) => {
  const heads = page.locator('[id^="hfy-sec-"][id$="-h"] button[aria-expanded="false"]');
  for (let n = await heads.count(); n > 0; n = await heads.count()) await heads.first().click();
};

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test(`/edit/: the person editor, the change bar, the check sheet, and a note`, async ({ browser }, testInfo) => {
      const { page, ctx } = await as(browser, ME, viewport);
      await page.goto("/edit/?cls=person&id=I0001", { waitUntil: "domcontentloaded" });
      await expect(page.locator("[data-hfy-editor-ready]")).toBeVisible();
      await expandAll(page);
      await audit(page, testInfo, "edit-person");
      await page.getByLabel("nickname", { exact: true }).fill("Ally");
      await page.getByLabel("given names", { exact: true }).fill("Aldric");
      await expect(page.locator("[data-hfy-bar]")).toBeVisible();
      await audit(page, testInfo, "edit-person-changed");
      await page.locator("[data-hfy-review]").click();
      await expect(page.locator('dialog.hfy-sheet [data-hfy-group="hfy-sheet-review"]')).toBeVisible();
      await audit(page, testInfo, "edit-check-sheet");
      await page.locator("dialog.hfy-sheet [data-hfy-save]").click();
      await expect(page.locator("[data-hfy-toast]")).toBeVisible();
      await audit(page, testInfo, "edit-saved-toast");
      await page.goto("/edit/?cls=note&id=N0001", { waitUntil: "domcontentloaded" });
      await expect(page.locator("[data-hfy-editor-ready]")).toBeVisible();
      await expandAll(page);
      await audit(page, testInfo, "edit-note");
      await ctx.close();
    });

    test(`/edit/family/: the start screen, a question, a new person, the summary and the sent line`, async ({ browser }, testInfo) => {
      const { page, ctx } = await as(browser, ME, viewport);
      await page.goto("/edit/family/?id=I0001", { waitUntil: "domcontentloaded" });
      const choice = (text) => page.locator("[data-hfy-choice]", { hasText: text }).first();
      await expect(page.locator('[data-hfy-screen="start"]')).toBeVisible();
      await audit(page, testInfo, "family-start");
      await choice("my parents").click();
      await choice("my mother").click();
      await page.locator("[data-hfy-search]").fill("Hazel");
      await expect(page.locator('[data-hfy-person="I0003"]')).toBeVisible();
      await audit(page, testInfo, "family-search");
      await page.locator('[data-hfy-person="I0003"]').click();
      await audit(page, testInfo, "family-relation");
      await choice("birth mother").click();
      await choice("add another parent").click();
      await choice("my father").click();
      await page.locator("[data-hfy-new]").click();
      await audit(page, testInfo, "family-new-person");
      await page.locator("[data-hfy-given]").fill("Moss");
      await page.locator("[data-hfy-surname]").fill("Testwood");
      await page.locator("[data-hfy-birth-year]").fill("1960");
      await page.locator('[data-hfy-living="no"]').check();
      await page.locator("[data-hfy-continue]").click();
      await choice("birth father").click();
      await expect(page.locator('[data-hfy-screen="summary"]')).toBeVisible();
      await audit(page, testInfo, "family-summary");
      await page.locator("[data-hfy-send]").click();
      await expect(page.locator("[data-hfy-sent]")).toBeVisible();
      await audit(page, testInfo, "family-sent");
      await ctx.close();
    });

    test(`/me/review/: the admin queue and card, the decline sheet, and a member's own suggestions`, async ({ browser }, testInfo) => {
      const sent = await world.call("POST", "/api/changes", ME, {
        body: { target: `Person:${world.me.handle}`, base_versions: { [`Person:${world.me.handle}`]: 1 }, note: "the spelling on my certificate", ops: [{ id: "first", op: "set", obj: `Person:${world.me.handle}`, path: "/primary_name/first_name", base: "Alder", value: "Aldric" }] },
        headers: { "idempotency-key": "audit-1" },
      });
      expect(sent.status).toBe(201);
      const admin = await as(browser, ADMIN, viewport);
      await admin.page.goto("/me/review/", { waitUntil: "domcontentloaded" });
      await expect(admin.page.locator("[data-hfy-review-ready]")).toBeVisible();
      await audit(admin.page, testInfo, "review-queue");
      await admin.page.locator("[data-hfy-items] > li").first().getByRole("button").click();
      await expect(admin.page.locator("[data-hfy-proposal-card]")).toBeVisible();
      await audit(admin.page, testInfo, "review-card");
      await admin.page.locator('[data-hfy-act="decline"]').click();
      await expect(admin.page.locator("[data-hfy-reason-sheet='decline']")).toBeVisible();
      await audit(admin.page, testInfo, "review-decline-sheet");
      await admin.ctx.close();
      const member = await as(browser, ME, viewport);
      await member.page.goto("/me/review/?tab=mine", { waitUntil: "domcontentloaded" });
      await expect(member.page.locator("[data-hfy-review-ready]")).toBeVisible();
      await member.page.locator("[data-hfy-items] > li").first().getByRole("button").click();
      await expect(member.page.locator("[data-hfy-proposal-card]")).toBeVisible();
      await audit(member.page, testInfo, "review-mine-card");
      await member.page.locator('[data-hfy-act="edit"]').click();
      await expect(member.page.locator("[data-hfy-amend]")).toBeVisible();
      await audit(member.page, testInfo, "review-mine-edit");
      await member.ctx.close();
    });
  });
}
