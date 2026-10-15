// HFY-TSK-282 (edit-e2e-d11-audit): the editing scenarios end to end in a real browser against the REAL API over the fake store (edit-e2e-bridge.mjs).
// Own nickname direct save and undo; a given-name change becomes a proposal and an admin approves it (the bundle is at version +1); a stale proposal
// is updated by its proposer and then approved; the parents wizard is approved and both sides of every link are present; a phone number in a note is
// refused until it is removed. Synthetic people only. Runs on localhost against the committed site:
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/edit-e2e.spec.mjs
import { test, expect } from "@playwright/test";
import { ADMIN, ME } from "../../api/test/edit-e2e-world.js";
import { attach, createEditWorld } from "./edit-e2e-bridge.mjs";

test.use({ viewport: { width: 375, height: 812 } });

let world;
test.beforeEach(async () => { world = await createEditWorld(); });
test.afterEach(() => world.dispose());

const field = (page, label) => page.getByLabel(label, { exact: true });
const sheet = (page) => page.locator("dialog.hfy-sheet");
const card = (page) => page.locator("[data-hfy-proposal-card]");
const act = (page, a) => card(page).locator(`[data-hfy-act="${a}"]`);
const rows = (page) => page.locator("[data-hfy-items] > li");

/** A new tab acting as `id`. */
async function as(browser, id, label) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  const log = await attach(page, world, { id, label });
  return { page, log, ctx };
}
async function openEditor(page, query = "cls=person&id=I0001") {
  await page.goto(`/edit/?${query}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-hfy-editor-ready]")).toBeVisible();
}
/** The admin queue: open the first waiting suggestion and approve it; the card says it is on the tree. */
async function approveFirst(page) {
  await page.goto("/me/review/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-hfy-review-ready]")).toBeVisible();
  await rows(page).first().getByRole("button").click();
  await expect(act(page, "approve")).toBeEnabled();
  await act(page, "approve").click();
  await expect(card(page)).toHaveAttribute("data-state", "approved");
}

test("scenario 1: my nickname saves now, the toast offers undo, and undo puts it back", async ({ browser }) => {
  const { page, ctx } = await as(browser, ME, "Alder Testwood");
  await openEditor(page);
  await field(page, "nickname").fill("Ally");
  await page.locator("[data-hfy-review]").click();
  await expect(sheet(page).locator('[data-hfy-group="hfy-sheet-direct"] li')).toHaveCount(1);
  await expect(sheet(page).locator('[data-hfy-group="hfy-sheet-review"]')).toHaveCount(0);
  await sheet(page).locator("[data-hfy-save]").click();
  await expect(page.locator("[data-hfy-toast-text]")).toHaveText("saved.");
  expect(world.stored("Person", world.me.handle).primary_name.nick).toBe("Ally");
  expect(world.version("Person", world.me.handle)).toBe(2);
  expect(world.rows("PROP#")).toEqual([]);
  await page.locator("[data-hfy-undo]").click();
  await expect(page.locator("[data-hfy-toast-text]")).toHaveText("undone.");
  await expect(field(page, "nickname")).toHaveValue("");
  expect(world.stored("Person", world.me.handle).primary_name.nick).toBe("");
  await ctx.close();
});

test("scenario 2: a given-name change goes to review, an admin approves it, and the bundle is at version +1", async ({ browser }) => {
  const member = await as(browser, ME, "Alder Testwood");
  await openEditor(member.page);
  await field(member.page, "given names").fill("Aldric");
  await member.page.locator("[data-hfy-review]").click();
  await expect(sheet(member.page).locator('[data-hfy-group="hfy-sheet-review"] li')).toHaveCount(1);
  await sheet(member.page).locator("[data-hfy-note]").fill("the spelling on my certificate");
  await sheet(member.page).locator("[data-hfy-save]").click();
  await expect(member.page.locator("[data-hfy-toast-text]")).toHaveText("sent. you can change or withdraw it until an admin looks.");
  expect(world.stored("Person", world.me.handle).primary_name.first_name).toBe("Alder"); // not yet
  expect(world.version("Person", world.me.handle)).toBe(1);

  const admin = await as(browser, ADMIN, "Admin Example");
  await approveFirst(admin.page);
  expect(world.stored("Person", world.me.handle).primary_name.first_name).toBe("Aldric");
  expect(world.version("Person", world.me.handle)).toBe(2);
  const bundle = await world.call("GET", `/api/edit/Person/${ME}`, ME);
  expect(bundle.body).toMatchObject({ version: 2, pending: [] });
  expect(bundle.body.obj.primary_name.first_name).toBe("Aldric");
  await member.ctx.close();
  await admin.ctx.close();
});

test("scenario 3: a stale proposal is updated by its proposer and then approved", async ({ browser }) => {
  const member = await as(browser, ME, "Alder Testwood");
  await openEditor(member.page);
  await field(member.page, "given names").fill("Aldric");
  await member.page.locator("[data-hfy-review]").click();
  await sheet(member.page).locator("[data-hfy-save]").click();
  await expect(member.page.locator("[data-hfy-toast]")).toBeVisible();
  // a Gramps sync renames the same field before anyone looks
  await world.bump({ ...world.stored("Person", world.me.handle), primary_name: { ...world.me.primary_name, first_name: "Alden" } }, 1);

  const admin = await as(browser, ADMIN, "Admin Example");
  await admin.page.goto("/me/review/", { waitUntil: "domcontentloaded" });
  await admin.page.locator('[data-hfy-chip="out-of-date"]').click(); // the page moved on, so the queue files it under out of date
  await rows(admin.page).first().getByRole("button").click();
  await expect(card(admin.page)).toHaveAttribute("data-hfy-rebase", "conflict");
  await expect(act(admin.page, "approve")).toBeDisabled(); // approve stays off while the page and the suggestion disagree
  expect(world.stored("Person", world.me.handle).primary_name.first_name).toBe("Alden");

  // the proposer sees that it needs an update, and sends the change again on top of what the page says now
  await member.page.goto("/me/review/?tab=mine", { waitUntil: "domcontentloaded" });
  await expect(member.page.locator("[data-hfy-review-ready]")).toBeVisible();
  await rows(member.page).first().getByRole("button").click();
  await expect(card(member.page)).toHaveAttribute("data-mode", "mine");
  await act(member.page, "edit").click();
  const form = card(member.page).locator("[data-hfy-amend]");
  await form.getByLabel("keep their suggestion", { exact: false }).check(); // keep my wording on top of what the page says now
  await form.locator("[data-hfy-amend-send]").click();
  await expect(card(member.page).locator("[data-hfy-notice]")).toContainText("saved.");
  const stored = [...world.rows("PROP#")].find((r) => r.SK === "META").proposal;
  expect(stored).toMatchObject({ state: "pending", rev: 2 });

  await approveFirst(admin.page);
  expect(world.stored("Person", world.me.handle).primary_name.first_name).toBe("Aldric");
  expect(world.version("Person", world.me.handle)).toBe(3);
  await member.ctx.close();
  await admin.ctx.close();
});

test("scenario 4: the parents wizard is approved and both sides of every link are present", async ({ browser }) => {
  const member = await as(browser, ME, "Alder Testwood");
  const page = member.page;
  await page.goto("/edit/family/?id=I0001", { waitUntil: "domcontentloaded" });
  const choice = (text) => page.locator("[data-hfy-choice]", { hasText: text }).first();
  await expect(page.locator('[data-hfy-screen="start"]')).toBeVisible();
  await choice("my parents").click();
  await choice("my mother").click();
  await page.locator("[data-hfy-search]").fill("Hazel");
  await page.locator('[data-hfy-person="I0003"]').click();
  await choice("birth mother").click();
  await expect(page.locator('[data-hfy-screen="p.more"]')).toBeVisible();
  await choice("add another parent").click();
  await choice("my father").click();
  await page.locator("[data-hfy-new]").click();
  await page.locator("[data-hfy-given]").fill("Moss");
  await page.locator("[data-hfy-surname]").fill("Testwood");
  await page.locator("[data-hfy-birth-year]").fill("1960");
  await page.locator('[data-hfy-living="no"]').check();
  await page.locator("[data-hfy-continue]").click();
  await choice("birth father").click();
  await expect(page.locator('[data-hfy-screen="summary"]')).toBeVisible();
  await expect(page.locator("[data-hfy-sentence]")).toHaveCount(3);
  await page.locator("[data-hfy-send]").click();
  await expect(page.locator("[data-hfy-sent]")).toBeVisible();
  expect(world.stored("Person", world.me.handle).parent_family_list).toEqual([]); // nothing on the tree yet

  const admin = await as(browser, ADMIN, "Admin Example");
  await approveFirst(admin.page);
  const me = world.stored("Person", world.me.handle);
  expect(me.parent_family_list).toHaveLength(1);
  const fam = world.stored("Family", me.parent_family_list[0]);
  const fatherHandle = fam.father_handle;
  expect(fatherHandle).toBeTruthy();
  expect(fam.mother_handle).toBe(world.mother.handle);
  expect(fam.child_ref_list.map((c) => c.ref)).toEqual([world.me.handle]);
  // each person names the family back
  expect(world.stored("Person", world.mother.handle).family_list).toContain(fam.handle);
  expect(world.stored("Person", fatherHandle).family_list).toContain(fam.handle);
  expect(world.stored("Person", fatherHandle).primary_name.first_name).toBe("Moss");
  await member.ctx.close();
  await admin.ctx.close();
});

test("scenario 5: a phone number in a note is refused until it is removed", async ({ browser }) => {
  const { page, ctx } = await as(browser, ME, "Alder Testwood");
  await openEditor(page, "cls=note&id=N0001");
  const text = page.getByLabel("note", { exact: true });
  await expect(text).toBeVisible();
  const before = world.ddb.all().length;
  await text.fill("A synthetic note about the family. Call 212-555-0143.");
  await page.locator("[data-hfy-review]").click();
  await expect(sheet(page).locator("[data-hfy-problem]")).toContainText("phone number");
  await expect(sheet(page).locator("[data-hfy-save]")).toHaveCount(0); // there is nothing to send
  expect(world.ddb.all().length).toBe(before);
  expect(world.rows("PROP#")).toEqual([]);
  // remove the number and look again
  await sheet(page).locator("[data-hfy-back]").click();
  await text.fill("A synthetic note about the family, edited.");
  await page.locator("[data-hfy-review]").click();
  await expect(sheet(page).locator("[data-hfy-problem]")).toHaveCount(0);
  await sheet(page).locator("[data-hfy-save]").click();
  await expect(page.locator("[data-hfy-toast]")).toBeVisible();
  const saved = world.rows("PROP#").length > 0 || world.stored("Note", world.n1.handle).text.string.includes("edited");
  expect(saved).toBe(true);
  await ctx.close();
});
