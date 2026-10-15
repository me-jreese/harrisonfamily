// HFY-TSK-282 (edit-e2e-d11-audit): the D-11 after-state audit for /edit/, /edit/family/ and /me/review/ at 375 and 1024 px, against the real API over the
// fake store (edit-e2e-bridge.mjs). Every state of each page is measured for: 16 px inputs, 44 px targets, one control height per row, no horizontal
// scroll, and axe (serious and critical) clean. The installed-iPhone PWA pass is io's UAT inside edit-flag-flip, not here.
// With HFY_AUDIT_SHOTS=<dir> each state is also saved as a screenshot (the audit document links them under the HFY-R16 asset prefix); without it nothing is written.
//   HFY_SITE=<dir> PW_PORT=<port> [HFY_AUDIT_SHOTS=<dir>] npx playwright test tests/edit-d11-audit.spec.mjs
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ADMIN, ME } from "../../api/test/edit-e2e-world.js";
import { attach, createEditWorld } from "./edit-e2e-bridge.mjs";
import { axeViolations } from "./axe.mjs";

const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1024", { width: 1024, height: 768 }]];
const SHOTS = process.env.HFY_AUDIT_SHOTS || "";

/** The D-11 measurements, run in the page: a list of findings (empty when the state is clean). */
const MEASURE = () => {
  const out = [];
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      if (n.tagName === "DIALOG" && !n.open) return false;
    }
    return true;
  };
  const name = (e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}${e.getAttribute("name") ? `[name=${e.getAttribute("name")}]` : ""} "${(e.getAttribute("aria-label") || e.textContent || e.value || "").trim().slice(0, 24)}"`;
  const fields = [...document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select")].filter(visible);
  for (const f of fields) if (parseFloat(getComputedStyle(f).fontSize) < 16) out.push(`input under 16px: ${name(f)} ${getComputedStyle(f).fontSize}`);
  // targets: buttons, fields, summaries, links that are not inside a sentence; a checkbox or radio is its label
  const targets = [...document.querySelectorAll("button, summary, [role=button], a[href], input:not([type=hidden]), textarea, select")].filter(visible);
  const measured = [];
  for (const t of targets) {
    let el = t;
    if (t.matches("input[type=checkbox], input[type=radio]")) el = t.closest("label") || document.querySelector(`label[for="${t.id}"]`) || t;
    if (t.tagName === "A") {
      const p = t.parentElement;
      const inline = getComputedStyle(t).display === "inline" && p && (p.textContent || "").replace(t.textContent, "").trim().length > 0; // other words around it
      if (inline) continue; // WCAG 2.5.8: a link inside a sentence is exempt
    }
    const r = el.getBoundingClientRect();
    measured.push({ el: t, r });
    if (r.height < 43.5 || r.width < 43.5) out.push(`target under 44px: ${name(t)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  // one control height per row: controls whose vertical centres sit within 3px of each other share a row
  const ctl = measured.filter((m) => m.el.matches("button, select, input:not([type=checkbox]):not([type=radio]), [role=button]"));
  const rows = [];
  for (const m of ctl.sort((a, b) => a.r.top + a.r.height / 2 - (b.r.top + b.r.height / 2))) {
    const c = m.r.top + m.r.height / 2;
    const row = rows.find((x) => Math.abs(x.c - c) <= 3 && x.items.every((i) => i.el.parentElement.closest("form, section, div") === m.el.parentElement.closest("form, section, div") || true));
    if (row) row.items.push(m); else rows.push({ c, items: [m] });
  }
  for (const row of rows) {
    const hs = row.items.filter((i) => i.r.left >= 0).map((i) => Math.round(i.r.height));
    if (hs.length > 1 && Math.max(...hs) - Math.min(...hs) > 1) out.push(`mixed control heights in one row: ${row.items.map((i) => `${name(i.el)} ${Math.round(i.r.height)}`).join("; ")}`);
  }
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth) out.push(`horizontal scroll: ${de.scrollWidth} > ${de.clientWidth}`);
  return out;
};

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
    test(`/edit/: the person editor, the change bar, the check sheet, a note and an event`, async ({ browser }, testInfo) => {
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
