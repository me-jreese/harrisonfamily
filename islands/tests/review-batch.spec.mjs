// HFY-TSK-388-0F (flag lifeDatesV1): the review queue's batch approval, contested compare and deceased confirm at 375 and 1280, axe clean.
// Synthetic people only; /auth, /api and the flags file are stubbed by route interception.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/review-batch.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { axeViolations } from "./axe.mjs";
import { ID, REBASE_CLEAN, view } from "./fixtures/proposals.mjs";

const ME = "I9003";
const PEOPLE = [
  { grampsId: "I9001", displayName: "Sam Example" }, { grampsId: "I9002", displayName: "Tessa Example" }, { grampsId: "I9003", displayName: "Admin Example" },
  { grampsId: "I9004", displayName: "Bea Example" }, { grampsId: "I9005", displayName: "Cal Example" },
];

const ld = (n, handle, gid, { birth, death, proposer = "I9001", note = "" } = {}) => view(n, {
  subject: { cls: "Person", handle, gramps_id: gid }, ops: [], note, proposer: { id: proposer, label: proposer === "I9001" ? "Sam Example" : "Tessa Example" },
  intent: { type: "life_dates", target: `Person:${handle}`, ...(birth ? { birth } : {}), ...(death ? { death } : {}), marks_deceased: Boolean(death) },
  summary: [{ text: "years" }],
});
const tagView = (n) => view(n, { ops: [{ id: "t", op: "add", obj: "Person:hsyn0002", path: "/media_list", value: { ref: "m1", rect: [10, 10, 40, 50] } }], summary: [{ text: "tag Tessa Example in this photo" }] });
const world = () => [
  ld(1, "h2", "I9002", { birth: { year: 1890, about: true } }),
  ld(2, "h4", "I9004", { death: { year: 1962 } }),
  ld(3, "h5", "I9005", { death: { year: 1950 } }),
  ld(4, "h5", "I9005", { death: { year: 1951 }, proposer: "I9006", note: "she told me" }),
  tagView(5),
];

async function stub(page, { lifeDatesV1 = true, proposals = world() } = {}) {
  const s = { decisions: [], asks: [], store: new Map(proposals.map((p) => [p.id, p])) };
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, proposalReview: true, recordEdit: true, lifeDatesV1 } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: ME, grampsId: ME, label: "Example" } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: PEOPLE } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { id: ME, label: "Example", admin: true, can: {}, editing: true } }));
  await page.route("**/api/comments**", (r) => r.fulfill({ json: { thread: { id: "x", topic: "comments", comments: [], reactions: {} } } }));
  await page.route(/\/api\/proposals/, async (r) => {
    const req = r.request();
    const u = new URL(req.url());
    const body = req.postData() ? JSON.parse(req.postData()) : undefined;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 2) {
      const items = [...s.store.values()].filter((p) => ["pending", "stale"].includes(p.state));
      return r.fulfill({ json: { items } });
    }
    const p = s.store.get(parts[2]);
    if (!p) return r.fulfill({ status: 404, json: { error: "not_found" } });
    if (parts.length === 3) return r.fulfill({ json: { ...p, rebase: REBASE_CLEAN } });
    if (parts[3] === "decision") {
      (body.verdict === "needs_changes" ? s.asks : s.decisions).push({ id: p.id, body, headers: await req.allHeaders() });
      const state = body.verdict === "approve" ? "approved" : "needs_changes";
      const next = { ...p, state, rev: p.rev + 1, etag: `${p.etag}x`, decision: { verdict: body.verdict, by: { id: ME, label: "Admin Example" }, at: p.created_at } };
      s.store.set(p.id, next);
      return r.fulfill({ json: { proposal: next } });
    }
    return r.fulfill({ status: 404, json: { error: "not_found" } });
  });
  return s;
}
const open = async (page, opts, query = "?tab=review") => { const s = await stub(page, opts); await page.goto(`/me/review/${query}`, { waitUntil: "domcontentloaded" }); return s; };
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const [label, size] of [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]]) {
  test(`${label}: batch approves the uncontested rows, names the contested, and confirms each death`, async ({ page }) => {
    await page.setViewportSize(size);
    const s = await open(page);
    const batch = page.locator("[data-hfy-batch]");
    await expect(batch.locator("[data-hfy-batch-row]")).toHaveCount(3);
    await expect(batch.locator("[data-hfy-batch-approve]")).toHaveText("approve 3");
    // contested rows are out of the batch and named, with their own compare
    await expect(batch.locator("[data-hfy-contested]")).toContainText("Cal Example");
    await expect(batch.locator("[data-hfy-batch-row]").filter({ hasText: "Cal Example" })).toHaveCount(0);
    await expect(batch.locator("[data-hfy-batch-row]").filter({ hasText: "Bea Example" }).locator("[data-hfy-deceased-mark]")).toHaveText("marks them deceased");
    expect(await noSideways(page)).toBe(true);
    expect(await axeViolations(page)).toEqual([]);
    const tap = await batch.locator("[data-hfy-batch-approve]").boundingBox();
    expect(tap.height).toBeGreaterThanOrEqual(44);
    await batch.locator("[data-hfy-batch-approve]").click();
    const dlg = page.getByRole("alertdialog");
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText("this will mark them as deceased");
    await expect(dlg.locator("[data-hfy-deceased-names]")).toContainText("Bea Example");
    expect(s.decisions).toHaveLength(0); // nothing is sent before the confirm
    await dlg.locator("[data-hfy-deceased-ok]").click();
    await expect(page.locator("[data-hfy-batch-done]")).toHaveText("approved 3. they reach Gramps on the next sync.");
    expect(s.decisions).toHaveLength(3);
    expect(s.decisions.every((d) => d.body.verdict === "approve" && d.headers["if-match"] && d.headers["idempotency-key"])).toBe(true);
    expect(new Set(s.decisions.map((d) => d.headers["idempotency-key"])).size).toBe(3);
    await expect(page.locator("[data-hfy-contested]")).toBeVisible(); // the contested pair stays
  });
}

test("cancelling the deceased confirm sends nothing; unticking a row leaves it out", async ({ page }) => {
  const s = await open(page);
  await page.locator('[data-hfy-batch-row] input').nth(0).uncheck();
  await expect(page.locator("[data-hfy-batch-approve]")).toHaveText("approve 2");
  await page.locator("[data-hfy-batch-approve]").click();
  await page.locator("[data-hfy-deceased-cancel]").click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(s.decisions).toHaveLength(0);
});

test("compare: two answers side by side, nothing chosen for you, death confirm, then one approval", async ({ page }) => {
  const s = await open(page);
  await page.locator("[data-hfy-compare]").click();
  const cmp = page.locator("[data-hfy-compare-panel]");
  await expect(cmp.locator("[data-hfy-cmp-opt]")).toHaveCount(2);
  await expect(cmp).toContainText("died 1950");
  await expect(cmp).toContainText("died 1951");
  await expect(cmp).toContainText("she told me");
  await expect(cmp.locator("[data-hfy-cmp-use]")).toBeDisabled();
  expect(await noSideways(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await cmp.locator("[data-hfy-cmp-opt]").nth(1).locator("input").check();
  await cmp.locator("[data-hfy-cmp-use]").click();
  await expect(page.getByRole("alertdialog")).toContainText("Cal Example");
  await page.locator("[data-hfy-deceased-ok]").click();
  await expect(page.locator("[data-hfy-compare-panel]")).toHaveCount(0);
  expect(s.decisions.map((d) => d.id)).toEqual([ID(4)]);
});

test("compare: 'neither, ask them' asks both and approves nothing", async ({ page }) => {
  const s = await open(page);
  await page.locator("[data-hfy-compare]").click();
  await page.locator("[data-hfy-cmp-neither]").click();
  await expect(page.locator("[data-hfy-flash]")).toHaveText("asked. they'll see your question.");
  expect(s.asks).toHaveLength(2);
  expect(s.decisions).toHaveLength(0);
});

test("a single approval that adds a death needs the confirm; a tag card shows the dashed box and 'not this one'", async ({ page }) => {
  const s = await open(page, {}, `?tab=review&p=${ID(2)}`);
  await page.locator('[data-hfy-act="approve"]').click();
  await expect(page.getByRole("alertdialog")).toContainText("this will mark them as deceased");
  expect(s.decisions).toHaveLength(0);
  await page.locator("[data-hfy-deceased-cancel]").click();
  await page.goto(`/me/review/?tab=review&p=${ID(5)}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-hfy-tag-card] [data-hfy-proposed-box]")).toBeVisible();
  await expect(page.locator('[data-hfy-act="decline"]')).toHaveText("not this one");
  expect(await axeViolations(page)).toEqual([]);
});

test("lifeDatesV1 off: no batch panel, and a death approves with no extra confirm", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const s = await open(page, { lifeDatesV1: false }, `?tab=review&p=${ID(2)}`);
  await expect(page.locator("[data-hfy-items]")).toBeVisible();
  await expect(page.locator("[data-hfy-batch]")).toHaveCount(0);
  await page.locator('[data-hfy-act="approve"]').click();
  await expect.poll(() => s.decisions.length).toBe(1);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});
