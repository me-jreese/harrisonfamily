// HFY-TSK-279 (sync-admin-status-page; flag syncStatusV1): /admin/sync/ at 375 (one column) and 1280 (two columns), axe clean, with a stubbed API. This is the
// D-11 audit run with ?hfy_flags=syncStatusV1: no sideways scroll, every button 44px or taller, full-width buttons on a phone, wrapping values.
// Also: the flag-off state (no bundle, no request), the not-allowed line, the signed-out line, the owner's decision (confirm step, body, step-up 401 with
// the fresh sign-in link, 409), and an hfy-admin reading without buttons. Synthetic values only.
// HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/admin-sync.spec.mjs
import { test, expect } from "@playwright/test";
import { axeViolations } from "./axe.mjs";

const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]];
const FLAGS = { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: false, profileLinks: false, recordSubsV1: false, syncStatusV1: false };
const LONG = "A very long synthetic value without any spaces so it has to wrap rather than push the page sideways ".repeat(2).replace(/ /g, "-");
const conflict = (n, over = {}) => ({
  id: `01J${String(n).padStart(23, "0")}`, class: "Person", handle: `h${n}`, gramps_id: `I000${n}`, kind: "field", source: "desktop_parked", state: "open", decision: null,
  paths: [{ path: "/primary_name/first_name", base: "Alder", cloud: n === 1 ? LONG : "Birch", desktop: "Cedar" }], opened_at: "2026-10-13T00:00:00.000Z", resolved_at: null, by: null, cloud_version: null, cloud_value_hash: null, reopened_at: null, history: [], applied_at: null, ...over,
});
const STATUS = (over = {}) => ({
  owner: true,
  desktop: [{ id: "instance-0001", addon_version: "0.1.0", gramps_version: "6.0.6", schema: 21, updated_at: "2026-10-14T11:59:30.000Z", last_run: { action: "sync", result: "ok", exit_code: 0, counts: { pulled: 3, pushed: 1 }, finished_at: "2026-10-14T11:59:00Z" } }],
  website: { head_seq: 12, rendered_seq: 9, render_lag: 3, render_mode: "live", last_render_error: "RenderFailed pass.failed", last_render_error_at: "2026-10-14T11:00:00.000Z", writes_enabled: true, seeded: true, bound: true },
  conflicts: [conflict(1), conflict(2)],
  batches: [{ id: "B2", at: "2026-10-14T10:02:00.000Z", by: "I9001", origin: "desktop", ops: 3, seq_from: 6, seq_to: 8 }, { id: "B1", at: "2026-10-14T10:01:00.000Z", by: "I9001", origin: "desktop", ops: 1, seq_from: 3, seq_to: 3 }],
  ...over,
});

async function stub(page, { flags = {}, session = "I9001", status = null, statusReply = null, decide = null } = {}) {
  const s = { calls: [], posts: [], bundles: [], data: status ?? STATUS() };
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { ...FLAGS, ...flags } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: session ? { authenticated: true, sub: session, grampsId: session, label: "Example" } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route(/\/js\/islands\/admin-sync\./, (r) => { s.bundles.push(r.request().url()); return r.continue(); });
  await page.route(/\/api\/sync\//, async (r) => {
    const req = r.request();
    const u = new URL(req.url());
    const rec = { method: req.method(), path: u.pathname, body: req.postData() ? JSON.parse(req.postData()) : undefined };
    s.calls.push(rec);
    if (req.method() === "GET") {
      if (statusReply) return r.fulfill(statusReply);
      return r.fulfill({ json: s.data });
    }
    s.posts.push(rec);
    if (decide) { const a = await decide(rec, s); if (a) return r.fulfill(a); }
    const id = u.pathname.split("/")[4];
    s.data = { ...s.data, conflicts: s.data.conflicts.filter((c) => c.id !== id) };
    return r.fulfill({ json: { id, state: "resolved", decision: rec.body.decision } });
  });
  return s;
}
const open = async (page, opts, query = "?hfy_flags=syncStatusV1") => {
  const s = await stub(page, opts);
  await page.goto(`/admin/sync/${query}`, { waitUntil: "domcontentloaded" });
  return s;
};
const act = (page, a) => page.locator(`[data-hfy-act="${a}"]`);

test.describe("flag off", () => {
  test("no bundle is requested, the page keeps its note and no request is made (HFY-R8)", async ({ page }) => {
    const s = await open(page, {}, "");
    await page.waitForTimeout(500);
    await expect(page.locator("[data-sync-off]")).toHaveText("the sync status isn't available yet.");
    expect(s.bundles).toEqual([]);
    expect(s.calls).toEqual([]);
  });
});

test("anyone else gets the standard not-allowed line", async ({ page }) => {
  await open(page, { statusReply: { status: 403, json: { error: "not_allowed", message: "this page is for the people who look after the site" } } });
  await expect(page.locator("[data-hfy-not-allowed]")).toHaveText("this page is for the people who look after the site.");
  await expect(page.locator("[data-hfy-sync-ready]")).toHaveCount(0);
});

test("signed out: the sign-in line and no request", async ({ page }) => {
  const s = await open(page, { session: null });
  await expect(page.locator("[data-hfy-gate]")).toContainText("sign in to see the sync status.");
  expect(s.calls).toEqual([]);
});

test("the switch off at the API reads not available", async ({ page }) => {
  await open(page, { statusReply: { status: 404, json: { error: "not_enabled", message: "the sync API is not enabled" } } });
  await expect(page.locator("[data-hfy-problem]")).toContainText("the sync status isn't available yet.");
});

test("an hfy-admin reads the cards and has no decision buttons", async ({ page }) => {
  await open(page, { status: STATUS({ owner: false }) });
  await expect(page.locator("[data-hfy-sync-ready]")).toBeVisible();
  await expect(page.locator("[data-hfy-conflict]")).toHaveCount(2);
  await expect(act(page, "keep-website")).toHaveCount(0);
  await expect(page.locator("[data-hfy-owner-only]").first()).toContainText("only the owner of the site can decide a conflict");
});

test("a decision the website's value outgrew is open again, with the 'cloud value changed' note and the earlier decision (HFY-TSK-338)", async ({ page }) => {
  const reopened = conflict(2, { reopened_at: "2026-10-14T10:00:00.000Z", history: [{ decision: "keep_cloud", cloud_version: 3, resolved_at: "2026-10-14T09:00:00.000Z", reopened_at: "2026-10-14T10:00:00.000Z", reason: "value_changed" }] });
  await open(page, { status: STATUS({ conflicts: [conflict(1), reopened] }) });
  await expect(page.locator("[data-hfy-sync-ready]")).toBeVisible();
  await expect(page.locator("[data-hfy-conflict]")).toHaveCount(2);
  await expect(page.locator("[data-hfy-reopened]")).toHaveCount(1);
  await expect(page.locator(`[data-hfy-conflict="${reopened.id}"] [data-hfy-reopened]`)).toContainText("cloud value changed");
  await expect(page.locator(`[data-hfy-conflict="${reopened.id}"] [data-hfy-reopened]`)).toContainText("earlier decision: keep website");
  await expect(page.locator(`[data-hfy-conflict="${reopened.id}"] [data-hfy-act="keep-website"]`)).toBeVisible(); // it can be decided again
  expect(await axeViolations(page)).toEqual([]);
});

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("the four cards show desktop, website, conflicts and recent batches; D-11: axe clean, no sideways scroll, 44px targets", async ({ page }) => {
      await open(page, {});
      await expect(page.locator("[data-hfy-sync-ready]")).toBeVisible();
      await expect(page.locator('[data-hfy-fact="run"]')).toHaveText("sync, ok");
      await expect(page.locator('[data-hfy-fact="addon"]')).toHaveText("0.1.0");
      await expect(page.locator('[data-hfy-fact="lag"]')).toHaveText("3 changes not on the site yet");
      await expect(page.locator("[data-hfy-render-error]")).toContainText("RenderFailed pass.failed");
      await expect(page.locator("[data-hfy-batch]")).toHaveCount(2);
      await expect(page.locator("[data-hfy-batch]").first()).toContainText("3 changes from the desktop");
      await expect(page.locator("[data-hfy-conflict]").first()).toContainText("person I0001");
      await expect(page.locator("[data-hfy-website-value]").nth(1)).toHaveText("Birch");
      await expect(page.locator("[data-hfy-desktop-value]").nth(1)).toHaveText("Cedar");
      expect(await axeViolations(page)).toEqual([]);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      const small = await page.evaluate(() => [...document.querySelectorAll(".hfy-syncadmin button, .hfy-syncadmin a")].filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.textContent));
      expect(small).toEqual([]);
      const font = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".hfy-syncadmin")).fontSize));
      expect(font).toBeGreaterThan(0);
    });

    test("the layout follows the width: one column under 64rem, two columns from it, full-width buttons on a phone", async ({ page }) => {
      await open(page, {});
      await expect(page.locator("[data-hfy-sync-ready]")).toBeVisible();
      const boxes = await page.evaluate(() => {
        const cols = [...document.querySelectorAll(".hfy-syncadmin__col")].map((c) => c.getBoundingClientRect());
        const btn = document.querySelector('[data-hfy-act="keep-website"]').getBoundingClientRect();
        const card = document.querySelector('[data-hfy-card="conflicts"]').getBoundingClientRect();
        return { left: cols[0], right: cols[1], btn, card };
      });
      if (name === "375") {
        expect(boxes.right.top).toBeGreaterThanOrEqual(boxes.left.bottom - 1); // stacked
        expect(boxes.btn.width).toBeGreaterThan(boxes.card.width * 0.8); // full width
      } else {
        expect(boxes.right.left).toBeGreaterThanOrEqual(boxes.left.right); // side by side
        expect(Math.abs(boxes.right.top - boxes.left.top)).toBeLessThan(40);
      }
    });

    test("deciding: keep website asks first, posts {decision: keep_cloud} to the decision route and drops the conflict", async ({ page }) => {
      const s = await open(page, {});
      await act(page, "keep-website").first().click();
      await expect(page.locator("[data-hfy-confirm]")).toContainText("keep the website's value for person I0001?");
      expect(await axeViolations(page)).toEqual([]);
      expect(s.posts).toEqual([]); // nothing is sent before the second press
      await act(page, "confirm").first().click();
      await expect(page.locator("[data-hfy-result]")).toContainText("kept the website's value");
      expect(s.posts).toHaveLength(1);
      expect(s.posts[0]).toMatchObject({ method: "POST", path: "/api/sync/conflicts/01J00000000000000000000001/decision", body: { decision: "keep_cloud" } });
      await expect(page.locator("[data-hfy-conflict]")).toHaveCount(1);
    });

    test("keep desktop posts keep_desktop, and 'not yet' sends nothing", async ({ page }) => {
      const s = await open(page, {});
      await act(page, "keep-desktop").first().click();
      await act(page, "cancel").click();
      expect(s.posts).toEqual([]);
      await act(page, "keep-desktop").first().click();
      await act(page, "confirm").first().click();
      await expect(page.locator("[data-hfy-result]")).toContainText("kept the desktop's value");
      expect(s.posts[0].body).toEqual({ decision: "keep_desktop" });
    });

    test("a stale sign-in (401 step_up_required) offers a fresh sign-in link back to this page; a 409 reloads the list", async ({ page }) => {
      let n = 0;
      const s = await open(page, { decide: async () => (++n === 1 ? { status: 401, json: { error: "step_up_required", message: "this action needs a fresh sign-in" } } : { status: 409, json: { error: "already_resolved" } }) });
      await act(page, "keep-website").first().click();
      await act(page, "confirm").first().click();
      const link = page.locator("[data-hfy-problem='signin'] a");
      await expect(link).toHaveText("sign in again");
      const href = await link.getAttribute("href");
      expect(href).toContain("/auth/login?prompt=login&returnTo=");
      expect(decodeURIComponent(href)).toContain("/admin/sync/");
      await act(page, "keep-website").first().click();
      await act(page, "confirm").first().click();
      await expect(page.locator("[data-hfy-problem='reload']")).toContainText("already decided");
      expect(s.posts).toHaveLength(2);
    });
  });
}
