// HFY-TSK-295 (edit-admin-delete; flag adminDelete): the delete card at the foot of /edit/ for an admin, its sheet (dry run, then the delete under an
// Idempotency-Key, step-up, the budget), and the "possible duplicates" tab on /me/review/. At 375 and 1280, axe clean. Synthetic people only; /auth,
// /api, the flags file and the people index are stubbed by route interception.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/admin-delete.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";
import { EDIT_SCHEMAS } from "../src/lib/edit-schemas.js";

const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]];
const POLICY = JSON.parse(readFileSync(new URL("./fixtures/edit-policy-person.json", import.meta.url), "utf8"));
const OBJ = {
  _class: "Person", handle: "hsyn0001", gramps_id: "I9001",
  primary_name: { _class: "Name", first_name: "Test", nick: "Tess", surname_list: [{ _class: "Surname", surname: "Person", primary: true }] }
};
const FLAGS = { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: false, profileLinks: false, recordSubsV1: false };

const PLAN = {
  plan: {
    delete: [
      { key: "Person:hsyn0001", class: "Person", gramps_id: "I9001", label: "Test Person", why: "target" },
      { key: "Event:hsyn0101", class: "Event", gramps_id: "E9001", label: "", why: "exclusive_event" },
    ],
    update: [{ key: "Family:hsyn0201", class: "Family", gramps_id: "F9001", label: "" }],
    retired_ids: ["I9001"], objects: 3,
  },
  budget: { used: 1, adding: 2, limit: 10, over: false },
  summary: [], warnings: [], errors: [],
};
const PAIRS = {
  items: [
    { a: { key: "Person:hsyn0301", gramps_id: "I9301", displayName: "Wren Fernley", lifespan: "1990-" }, b: { key: "Person:hsyn0302", gramps_id: "I9302", displayName: "Wren Fernly", lifespan: "" }, score: 3 },
    { a: { key: "Person:hsyn0303", gramps_id: "I9303", displayName: "Jon Oakbridge", lifespan: "" }, b: { key: "Person:hsyn0304", gramps_id: "I9304", displayName: "Jonathan Oakbridge", lifespan: "" }, score: 3 },
  ],
  cursor: null, total: 2,
};

/** `del(req, s)` may answer a POST /api/admin/deletes itself (return {status, json}); the default answers the plan, or 201 for the real delete. */
async function stub(page, { flags = {}, admin = true, session = "I9099", del = null, dups = PAIRS, dupsStatus = 200 } = {}) {
  const s = { deletes: [], dupGets: [], bundleGets: 0, changes: [] };
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { ...FLAGS, recordEdit: true, proposalReview: true, adminDelete: true, ...flags } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: session ? { authenticated: true, sub: session, grampsId: session, label: "Admin Example" } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { id: session, label: "Admin Example", admin, can: {}, ownRecord: null, editing: true } }));
  await page.route("**/api/comments**", (r) => r.fulfill({ json: { thread: { id: "x", topic: "comments", comments: [], reactions: {} } } }));
  await page.route("**/api/proposals**", (r) => r.fulfill({ json: { items: [] } }));
  await page.route("**/api/edit/schema/Person", (r) => r.fulfill({ json: { class: "Person", schema: EDIT_SCHEMAS.Person, sha256: "0".repeat(64), schemaHash: "0".repeat(64) } }));
  await page.route("**/api/edit/Person/*", (r) => {
    s.bundleGets += 1;
    return r.fulfill({ json: { key: "Person:hsyn0001", version: 4, etag: "Person:hsyn0001@4", obj: OBJ, related: {}, relation: "other", viewer: { admin }, policy: POLICY, pending: [], customTypes: {}, schemaHash: "0".repeat(64) } });
  });
  await page.route("**/api/changes", (r) => { s.changes.push(r.request().url()); return r.fulfill({ status: 500, json: { error: "unexpected" } }); });
  await page.route("**/api/admin/deletes", async (r) => {
    const req = r.request();
    const rec = { body: JSON.parse(req.postData() || "{}"), headers: await req.allHeaders() };
    s.deletes.push(rec);
    if (del) { const a = await del(rec, s); if (a) return r.fulfill(a); }
    if (rec.body.dry_run) return r.fulfill({ json: PLAN });
    return r.fulfill({ status: 201, json: { applied: { versions: {}, undo: null, deleted: ["Person:hsyn0001"] }, proposal: null, summary: [] } });
  });
  await page.route("**/api/admin/duplicates**", (r) => {
    s.dupGets.push(new URL(r.request().url()).search);
    return dupsStatus === 200 ? r.fulfill({ json: dups }) : r.fulfill({ status: dupsStatus, json: { error: "server" } });
  });
  return s;
}
const openEditor = async (page, opts) => {
  const s = await stub(page, opts);
  await page.goto("/edit/?cls=person&id=I9001", { waitUntil: "domcontentloaded" });
  return s;
};
const card = (page) => page.locator("[data-hfy-admin-delete]");
const sheet = (page) => page.locator("dialog[data-hfy-delete-sheet]");

test.describe("flag off, or not an admin: no delete card", () => {
  test("flag off", async ({ page }) => {
    const s = await openEditor(page, { flags: { adminDelete: false } });
    await expect(page.locator("[data-hfy-editor-ready]")).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    expect(s.deletes).toEqual([]);
  });
  test("a member, flag on", async ({ page }) => {
    const s = await openEditor(page, { admin: false });
    await expect(page.locator("[data-hfy-editor-ready]")).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    expect(s.deletes).toEqual([]);
  });
});

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("an admin sees the card; nothing is sent until they ask, and the sheet lists what goes, what loses a link and the ids (axe clean)", async ({ page }) => {
      const s = await openEditor(page);
      await expect(page.locator("[data-hfy-editor-ready]")).toBeVisible();
      if (name === "375") await page.locator('#sec-delete button.hfy-editor__toggle').click();
      await expect(card(page)).toBeVisible();
      expect(s.deletes).toEqual([]);
      await page.locator("[data-hfy-delete-open]").click();
      await expect(sheet(page)).toHaveAttribute("data-hfy-delete-sheet", "ready");
      await expect(sheet(page).locator("h2")).toHaveText("delete this person?");
      await expect(sheet(page).locator('[data-hfy-group="hfy-delete-goes"] li')).toHaveText(["Test Person (I9001)", "event E9001: an event that only this page used"]);
      await expect(sheet(page).locator('[data-hfy-group="hfy-delete-links"] li')).toHaveText(["family F9001"]);
      await expect(sheet(page).locator("[data-hfy-ids]")).toHaveText("the id I9001 can never be used again.");
      await expect(sheet(page).locator("[data-hfy-budget]")).toContainText("1 deleted in the last day");
      expect(s.deletes).toHaveLength(1);
      expect(s.deletes[0].body).toEqual({ targets: ["Person:hsyn0001"], base_versions: { "Person:hsyn0001": 4 }, remove_references: true, dry_run: true });
      expect(await axeViolations(page)).toEqual([]);
      for (const sel of ["[data-hfy-delete-confirm]", "[data-hfy-delete-cancel]"]) {
        const box = await page.locator(sel).boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    });

    test("keep it closes the sheet and nothing is deleted", async ({ page }) => {
      const s = await openEditor(page);
      if (name === "375") await page.locator('#sec-delete button.hfy-editor__toggle').click();
      await page.locator("[data-hfy-delete-open]").click();
      await expect(sheet(page)).toHaveAttribute("data-hfy-delete-sheet", "ready");
      await page.locator("[data-hfy-delete-cancel]").click();
      await expect(sheet(page)).toHaveAttribute("data-hfy-delete-sheet", "closed");
      expect(s.deletes.filter((d) => !d.body.dry_run)).toEqual([]);
    });

    test("delete for good sends the same body under one Idempotency-Key and says the page is gone", async ({ page }) => {
      const s = await openEditor(page);
      if (name === "375") await page.locator('#sec-delete button.hfy-editor__toggle').click();
      await page.locator("[data-hfy-delete-open]").click();
      await page.locator("[data-hfy-delete-confirm]").click();
      await expect(page.locator("[data-hfy-admin-done]")).toContainText("deleted. that page is gone.");
      const real = s.deletes.filter((d) => !d.body.dry_run);
      expect(real).toHaveLength(1);
      expect(real[0].body).toEqual({ targets: ["Person:hsyn0001"], base_versions: { "Person:hsyn0001": 4 }, remove_references: true });
      expect(real[0].headers["idempotency-key"]).toMatch(/\S{8,}/);
      expect(s.changes).toEqual([]);
    });

    test("a stale sign-in (401 step_up_required) asks to sign in again, with a fresh-login link, and deletes nothing", async ({ page }) => {
      const s = await openEditor(page, { del: (rec) => (rec.body.dry_run ? { status: 401, json: { error: "step_up_required", details: { maxAgeSeconds: 900 } } } : null) });
      if (name === "375") await page.locator('#sec-delete button.hfy-editor__toggle').click();
      await page.locator("[data-hfy-delete-open]").click();
      await expect(sheet(page).locator("[data-hfy-problem]")).toContainText("sign in again");
      await expect(sheet(page).locator("a.hfy-sheet__signin")).toHaveAttribute("href", /^\/auth\/login\?prompt=login&returnTo=/);
      await expect(page.locator("[data-hfy-delete-confirm]")).toHaveCount(0);
      expect(s.deletes.filter((d) => !d.body.dry_run)).toEqual([]);
    });

    test("over the day's budget: the sheet says so and the delete button is off", async ({ page }) => {
      await openEditor(page, { del: (rec) => (rec.body.dry_run ? { json: { ...PLAN, budget: { used: 9, adding: 2, limit: 10, over: true, reason: "budget" } } } : null) });
      if (name === "375") await page.locator('#sec-delete button.hfy-editor__toggle').click();
      await page.locator("[data-hfy-delete-open]").click();
      await expect(sheet(page).locator("[data-hfy-budget]")).toContainText("use gramps on the desktop");
      await expect(page.locator("[data-hfy-delete-confirm]")).toBeDisabled();
    });

    test("a refusal on the delete itself (403 delete_budget) is shown in the sheet and the page stays", async ({ page }) => {
      await openEditor(page, { del: (rec) => (rec.body.dry_run ? null : { status: 403, json: { error: "delete_budget", details: { reason: "budget" } } }) });
      if (name === "375") await page.locator('#sec-delete button.hfy-editor__toggle').click();
      await page.locator("[data-hfy-delete-open]").click();
      await page.locator("[data-hfy-delete-confirm]").click();
      await expect(sheet(page).locator("[data-hfy-problem]")).toContainText("use gramps on the desktop");
      await expect(page.locator("[data-hfy-admin-done]")).toHaveCount(0);
    });

    test("the review page's 'possible duplicates' tab lists the pairs as links, and only reads", async ({ page }) => {
      const s = await stub(page);
      await page.goto("/me/review/?tab=duplicates", { waitUntil: "domcontentloaded" });
      await expect(page.locator('[data-hfy-tab="duplicates"]')).toHaveText("possible duplicates");
      await expect(page.locator('[data-hfy-tab="duplicates"]')).toHaveAttribute("aria-current", "page");
      await expect(page.locator("[data-hfy-pair]")).toHaveCount(2);
      await expect(page.locator("[data-hfy-pair]").first()).toContainText("Wren Fernley (I9301, 1990-)");
      await expect(page.locator("[data-hfy-pair] a").first()).toHaveAttribute("href", "/person/?id=I9301");
      await expect(page.locator("[data-hfy-dups]")).toContainText("merge the ones that are the same person in gramps on the desktop");
      expect(s.dupGets).toEqual(["?limit=50"]);
      expect(await axeViolations(page)).toEqual([]);
    });
  });
}

test.describe("the duplicates tab, other cases", () => {
  test("no tab without the flag, and the list is never asked for", async ({ page }) => {
    const s = await stub(page, { flags: { adminDelete: false } });
    await page.goto("/me/review/?tab=duplicates", { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-hfy-review-ready]")).toBeVisible();
    await expect(page.locator('[data-hfy-tab="duplicates"]')).toHaveCount(0);
    expect(s.dupGets).toEqual([]);
  });
  test("a member never has it", async ({ page }) => {
    const s = await stub(page, { admin: false, session: "I9001" });
    await page.goto("/me/review/?tab=duplicates", { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-hfy-review-ready]")).toBeVisible();
    await expect(page.locator('[data-hfy-tab="duplicates"]')).toHaveCount(0);
    expect(s.dupGets).toEqual([]);
  });
  test("an empty list says so, and a failed read offers to try again", async ({ page }) => {
    await stub(page, { dups: { items: [], cursor: null, total: 0 } });
    await page.goto("/me/review/?tab=duplicates", { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-hfy-empty]")).toHaveText("no possible duplicates right now.");
  });
  test("a failed read", async ({ page }) => {
    await stub(page, { dupsStatus: 500 });
    await page.goto("/me/review/?tab=duplicates", { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-hfy-dups] [role=alert]")).toContainText("the list didn't load");
  });
});
