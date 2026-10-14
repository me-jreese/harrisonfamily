// HFY-TSK-264 (surf-access-admin-ui; flag accessRequests): /me/requests/ at 375 (separate list and detail views) and 1280 (two columns), axe clean, with
// a stubbed API: the tabs, the masked email with no copy button, "who is this?" (candidates from a stubbed family index), "it's them" behind the
// required "confirmed outside the site" box, the 409 and emailSent:false cases, "they're new" with the editable preview and a stubbed place index,
// decline with a note, remove access, the non-admin line, the flag-off state (no bundle), and the gear's dot and the hub's "family requests" row.
// Synthetic people only. HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/access-requests.spec.mjs
import { test, expect } from "@playwright/test";
import { axeViolations } from "./axe.mjs";
import { mapToGramps } from "../../shared/legacy-form.mjs";

const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]];
const ADMIN = "I9003";
const FLAGS = { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: false, profileLinks: false, recordSubsV1: false, accessRequests: true };
const PEOPLE = [
  { grampsId: "I9001", displayName: "Tessa Example", givenName: "Tessa", surname: "Example", birthYear: 1981, isLiving: true, lifespanSummary: "1981 -" },
  { grampsId: "I9002", displayName: "Tess Example", givenName: "Tess", surname: "Example", birthYear: 1950, isLiving: true },
  { grampsId: "I9007", displayName: "Tessa Example", givenName: "Tessa", surname: "Example", birthYear: 1920, isLiving: false, lifespanSummary: "1920 - 1990" },
  { grampsId: "I9004", displayName: "Sam Sample", givenName: "Sam", surname: "Sample", birthYear: 1981, isLiving: true },
];
const PLACES = [{ handle: "hplace1", grampsId: "P9001", displayName: "Springfield, Exampleland, Testia" }, { handle: "hplace2", grampsId: "P9002", displayName: "Fakeville, Exampleland, Testia" }];
const FORM = { email: "tessa@example.test", givenNames: "tessa", maidenSurname: "EXAMPLE", gender: "female", birthPlace: "Springfield, Exampleland", birthYear: "1981", currentPlace: "Fakeville, Exampleland", forSelf: true };
const NOW = Date.now();
const ago = (days) => new Date(NOW - days * 86400000).toISOString();

const request = (id, state, over = {}) => ({
  id, state, version: 3, createdAt: ago(3), email: "t***@example.test",
  form: { ...FORM, ...(over.form || {}) },
  preview: (() => { const m = mapToGramps(FORM, { storeCurrentCity: true, now: NOW }); return { person: m.person, events: m.events, placeQueries: m.placeQueries }; })(),
  ...(over.rest || {}),
});
const summary = (r) => ({ id: r.id, state: r.state, createdAt: r.createdAt, givenNames: r.form.givenNames, maidenSurname: r.form.maidenSurname, birthYear: Number(r.form.birthYear), birthPlace: r.form.birthPlace });

/** The stubbed world. `requests`: the store; `decide(req, s, r)` / `revoke(...)` may answer a POST itself. */
async function stub(page, { flags = {}, admin = true, session = ADMIN, requests = [request("req1", "pending"), request("req2", "pending", { form: { givenNames: "sam", maidenSurname: "SAMPLE", birthYear: "1990" } }), request("req3", "awaiting_record"), request("req4", "active", { rest: { decision: { grampsId: "I9001" } } })], decide = null, revoke = null, badge = 2 } = {}) {
  const s = { calls: [], posts: [], bundles: [], store: new Map(requests.map((r) => [r.id, r])), meCalls: 0 };
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { ...FLAGS, ...flags } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: session ? { authenticated: true, sub: session, grampsId: session, label: "Example" } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: PEOPLE } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route("**/place/index.json", (r) => r.fulfill({ json: PLACES }));
  await page.route(/\/js\/islands\/access-requests\./, (r) => { s.bundles.push(r.request().url()); return r.continue(); });
  await page.route("**/api/me", (r) => { s.meCalls += 1; return r.fulfill(session ? { json: { id: session, label: "Example", admin, can: {}, ...(admin ? { badges: { accessRequests: s.badge ?? badge } } : {}) } } : { status: 401, json: { error: "unauthenticated" } }); });
  await page.route(/\/api\/allow-grants\/revoke/, async (r) => {
    const req = r.request();
    const rec = { method: req.method(), path: new URL(req.url()).pathname, body: JSON.parse(req.postData() || "{}") };
    s.calls.push(rec);
    s.posts.push(rec);
    if (revoke) { const a = await revoke(rec, s); if (a) return r.fulfill(a); }
    for (const [id, x] of s.store) if (x.decision?.grampsId === rec.body.grampsId && x.state === "active") s.store.set(id, { ...x, state: "revoked" });
    return r.fulfill({ json: { revoked: [{ email: "t***@example.test" }] } });
  });
  await page.route(/\/api\/access-requests/, async (r) => {
    const req = r.request();
    const u = new URL(req.url());
    const rec = { method: req.method(), path: u.pathname, query: Object.fromEntries(u.searchParams), body: req.postData() ? JSON.parse(req.postData()) : undefined };
    s.calls.push(rec);
    if (!admin) return r.fulfill({ status: 403, json: { error: "not_admin", message: "only an admin can do that" } });
    const parts = u.pathname.split("/").filter(Boolean); // api, access-requests, id?, action?
    if (parts.length === 2) {
      const want = { pending: ["pending"], awaiting_record: ["awaiting_record"], done: ["active", "declined", "revoked", "expired"] }[rec.query.state] || ["pending"];
      return r.fulfill({ json: { items: [...s.store.values()].filter((x) => want.includes(x.state)).map(summary), cursor: null } });
    }
    const item = s.store.get(parts[2]);
    if (!item) return r.fulfill({ status: 404, json: { error: "not_found" } });
    if (parts.length === 3) return r.fulfill({ json: item });
    if (parts[3] === "decision") {
      s.posts.push(rec);
      if (decide) { const a = await decide(rec, s, item); if (a) return r.fulfill(a); }
      const state = rec.body.decision === "link" ? "active" : rec.body.decision === "new" ? "awaiting_record" : "declined";
      s.store.set(item.id, { ...item, state, version: item.version + 1 });
      s.badge = Math.max(0, (s.badge ?? badge) - 1);
      return r.fulfill({ json: { state, emailSent: true } });
    }
    return r.fulfill({ status: 404, json: { error: "not_found" } });
  });
  return s;
}

const open = async (page, opts, query = "") => {
  const s = await stub(page, opts);
  await page.goto(`/me/requests/${query}`, { waitUntil: "domcontentloaded" });
  return s;
};
const tab = (page, id) => page.locator(`[data-hfy-tab="${id}"]`);
const items = (page) => page.locator("[data-hfy-items] > li");
const act = (page, a) => page.locator(`[data-hfy-act="${a}"]`);

test.describe("flag off", () => {
  test("no bundle is requested, the page keeps its note and no request is made (HFY-R8)", async ({ page }) => {
    const s = await open(page, { flags: { accessRequests: false } });
    await page.waitForTimeout(500);
    await expect(page.locator("[data-requests-off]")).toHaveText("family requests aren't available yet.");
    expect(s.bundles).toEqual([]);
    expect(s.calls).toEqual([]);
  });
});

test("a non-admin sees one line and no request is made", async ({ page }) => {
  const s = await open(page, { admin: false });
  await expect(page.locator("[data-hfy-not-admin]")).toHaveText("this page is for the people who look after the site.");
  expect(s.calls).toEqual([]);
});

test("signed out: the sign-in line", async ({ page }) => {
  const s = await open(page, { session: null });
  await expect(page.locator("[data-hfy-gate]")).toContainText("sign in to see family requests.");
  expect(s.calls).toEqual([]);
});

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("the waiting tab lists the cards, and the view is axe clean", async ({ page }) => {
      await open(page, {});
      await expect(page.locator("[data-hfy-requests-ready]")).toBeVisible();
      await expect(tab(page, "waiting")).toHaveAttribute("aria-current", "page");
      await expect(items(page)).toHaveCount(2);
      await expect(items(page).first()).toContainText("Tessa Example");
      await expect(items(page).first()).toContainText("born 1981 · Springfield, Exampleland");
      await expect(items(page).first()).toContainText("asked 3 days ago");
      expect(await axeViolations(page)).toEqual([]);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });

    test("a detail shows the answers and the masked email with no copy button, and the layout follows the width", async ({ page }) => {
      await open(page, {});
      await items(page).first().locator("button").click();
      const detail = page.locator("[data-hfy-detail]");
      await expect(detail).toBeVisible();
      await expect(page.locator("[data-hfy-email]")).toHaveText("t***@example.test");
      await expect(detail.getByRole("button", { name: /copy/i })).toHaveCount(0);
      await expect(page.locator("[data-hfy-answers]")).toContainText("Springfield, Exampleland");
      if (name === "375") {
        await expect(page).toHaveURL(/\?id=req1/);
        await expect(page.locator("[data-hfy-items]")).toHaveCount(0); // separate views
        await expect(page.locator("[data-hfy-back]")).toBeVisible();
      } else {
        await expect(page.locator("[data-hfy-items]")).toBeVisible(); // two columns
        const boxes = await page.evaluate(() => { const l = document.querySelector(".hfy-requests__list").getBoundingClientRect(); const d = document.querySelector(".hfy-requests__detail").getBoundingClientRect(); return { listRight: l.right, detailLeft: d.left, listTop: l.top, detailTop: d.top }; });
        expect(boxes.detailLeft).toBeGreaterThanOrEqual(boxes.listRight);
        expect(Math.abs(boxes.detailTop - boxes.listTop)).toBeLessThan(80);
      }
      expect(await axeViolations(page)).toEqual([]);
    });

    test("who is this? offers the living candidates as person links, and the actions are 44px tall", async ({ page }) => {
      await open(page, {}, "?id=req1");
      const cands = page.locator("[data-hfy-candidate]");
      await expect(cands.first()).toBeVisible();
      await expect(cands.first().locator("a.hfy-person-name")).toHaveAttribute("href", "/person/?id=I9001");
      await expect(page.locator('[data-hfy-candidate="I9007"]')).toHaveCount(0); // not living
      await expect(page.locator('[data-hfy-candidate="I9004"]')).toHaveCount(0); // no name match
      const small = await page.locator(".hfy-requests__actions button").evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 43.5).map((e) => e.textContent));
      expect(small).toEqual([]);
    });

    test("it's them needs the confirmed box, then lets them in and says the email went", async ({ page }) => {
      const s = await open(page, {}, "?id=req1");
      await page.locator('[data-hfy-candidate="I9001"] [data-hfy-act="its-them"]').click();
      const confirm = page.locator('[data-hfy-confirm="link"]');
      await expect(confirm).toContainText("give Tessa Example access as Tessa Example?");
      await expect(act(page, "let-in")).toBeDisabled();
      await confirm.getByLabel("confirmed with this person outside the site").check();
      await expect(act(page, "let-in")).toBeEnabled();
      await act(page, "let-in").click();
      await expect(page.locator("[data-hfy-result]")).toHaveText("done. we emailed them.");
      expect(s.posts).toHaveLength(1);
      expect(s.posts[0].body).toEqual({ decision: "link", grampsId: "I9001", version: 3, confirmedOutside: true });
      expect(await axeViolations(page)).toEqual([]);
    });

    test("emailSent:false says to let them know yourself", async ({ page }) => {
      await open(page, { decide: async () => ({ json: { state: "active", emailSent: false } }) }, "?id=req1");
      await page.locator('[data-hfy-candidate="I9001"] [data-hfy-act="its-them"]').click();
      await page.getByLabel("confirmed with this person outside the site").check();
      await act(page, "let-in").click();
      await expect(page.locator("[data-hfy-result]")).toHaveText("done, but the email didn't send. let them know yourself.");
    });

    test("a 409 conflict says the request changed and offers no retry; second_email offers the second-email button", async ({ page }) => {
      let n = 0;
      await open(page, { decide: async (rec) => {
        n += 1;
        if (n === 1) return { status: 409, json: { error: "conflict", message: "changed", details: { current: { state: "declined", version: 9 } } } };
        if (n === 2) return { status: 409, json: { error: "second_email", message: "has access" } };
        return { json: { state: "active", emailSent: true, memberNotified: true } };
      } }, "?id=req1");
      const them = page.locator('[data-hfy-candidate="I9001"] [data-hfy-act="its-them"]');
      await them.click();
      await page.getByLabel("confirmed with this person outside the site").check();
      await act(page, "let-in").click();
      await expect(page.locator('[data-hfy-problem="reload"]')).toContainText("this request changed while you were looking");
      await expect(act(page, "reload")).toBeVisible();
      await expect(act(page, "second-email")).toHaveCount(0);
      await act(page, "let-in").click();
      await expect(page.locator('[data-hfy-problem="second"]')).toBeVisible();
      await act(page, "second-email").click();
      await expect(page.locator("[data-hfy-result]")).toHaveText("done. we emailed them.");
    });

    test("a step-up answer links to a fresh sign-in", async ({ page }) => {
      await open(page, { decide: async () => ({ status: 401, json: { error: "step_up_required", message: "sign in again" } }) }, "?id=req1");
      await page.locator('[data-hfy-candidate="I9001"] [data-hfy-act="its-them"]').click();
      await page.getByLabel("confirmed with this person outside the site").check();
      await act(page, "let-in").click();
      await expect(page.locator('[data-hfy-problem="signin"] a')).toHaveAttribute("href", /^\/auth\/login\?prompt=login&returnTo=/);
    });

    test("they're new: the editable preview, the place picked from the place index, the confirm box, then the post", async ({ page }) => {
      const s = await open(page, {}, "?id=req1");
      await act(page, "new").click();
      const editor = page.locator("[data-hfy-preview-editor]");
      await expect(editor).toBeVisible();
      await expect(editor.locator('[data-hfy-preview="given"]')).toHaveValue("Tessa");
      await expect(editor.locator('[data-hfy-place="birth"]')).toHaveValue("hplace1"); // the one match is chosen
      await editor.locator('[data-hfy-preview="nick"]').fill("Tessie");
      await expect(act(page, "add-new")).toBeDisabled();
      await page.getByLabel("confirmed with this person outside the site").check();
      expect(await axeViolations(page)).toEqual([]);
      await act(page, "add-new").click();
      await expect(page.locator("[data-hfy-result]")).toHaveText("done. we emailed them.");
      const body = s.posts[0].body;
      expect(body.decision).toBe("new");
      expect(body.confirmedOutside).toBe(true);
      expect(body.preview.person.primary_name.nick).toBe("Tessie");
      expect(body.preview.events.find((e) => e.hfyKey === "birth").place).toBe("hplace1");
    });

    test("decline sends the note only when the include box is on", async ({ page }) => {
      const s = await open(page, {}, "?id=req1");
      await act(page, "decline").click();
      await page.locator("[data-hfy-note]").fill("we couldn't tell who you are");
      await page.getByLabel("include this note in the email").check();
      await act(page, "send-decline").click();
      await expect(page.locator("[data-hfy-result]")).toBeVisible();
      expect(s.posts[0].body).toEqual({ decision: "decline", version: 3, note: "we couldn't tell who you are", sendNote: true });
    });

    test("done tab: remove access asks, needs the box, and the keep button backs out", async ({ page }) => {
      const s = await open(page, {}, "?tab=done&id=req4");
      await act(page, "remove-open").click();
      await expect(page.locator('[data-hfy-confirm="revoke"]')).toContainText("remove Tessa Example's access?");
      await page.getByRole("button", { name: "keep" }).click();
      await expect(page.locator('[data-hfy-confirm="revoke"]')).toHaveCount(0);
      await act(page, "remove-open").click();
      await expect(act(page, "remove")).toBeDisabled();
      await page.getByLabel("confirmed with this person outside the site").check();
      await act(page, "remove").click();
      await expect(page.locator("[data-hfy-result]")).toHaveText("done. their access is removed.");
      expect(s.posts[0].path).toBe("/api/allow-grants/revoke");
      expect(s.posts[0].body).toEqual({ grampsId: "I9001", confirmedOutside: true });
      expect(s.calls.some((c) => /\/access-requests\/req4\/revoke/.test(c.path))).toBe(false);
      expect(await axeViolations(page)).toEqual([]);
    });

    for (const [status, code, text, kind] of [
      [404, "not_found", "they have no access to remove. it may already be gone.", "plain"],
      [422, "too_many", "this person has more ways in than can be removed here. ask the owner of the site.", "plain"],
      [401, "step_up_required", "to do this, sign in again first.", "signin"],
      [403, "not_admin", "this page is for the people who look after the site.", "plain"],
    ]) {
      test(`remove access: a ${status} ${code} answer reads in plain words`, async ({ page }) => {
        await open(page, { revoke: async () => ({ status, json: { error: code, message: "x" } }) }, "?tab=done&id=req4");
        await act(page, "remove-open").click();
        await page.getByLabel("confirmed with this person outside the site").check();
        await act(page, "remove").click();
        const problem = page.locator(`[data-hfy-problem="${kind}"]`);
        await expect(problem).toContainText(text);
        if (kind === "signin") await expect(problem.locator("a")).toHaveAttribute("href", /^\/auth\/login\?prompt=login&returnTo=/);
        expect(await axeViolations(page)).toEqual([]);
      });
    }

    test("a step-up sign-in keeps the preview edits (sessionStorage), and a finished add clears them", async ({ page }) => {
      let refuse = true;
      const s = await open(page, { decide: async () => (refuse ? { status: 401, json: { error: "step_up_required", message: "sign in again" } } : null) }, "?id=req1");
      await act(page, "new").click();
      const editor = page.locator("[data-hfy-preview-editor]");
      await editor.locator('[data-hfy-preview="nick"]').fill("Tessie");
      await page.getByLabel("confirmed with this person outside the site").check();
      await act(page, "add-new").click();
      await expect(page.locator('[data-hfy-problem="signin"]')).toBeVisible();
      // the sign-in leaves the page and returns to it: a fresh load of the same address
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(editor).toBeVisible();
      await expect(editor.locator('[data-hfy-preview="nick"]')).toHaveValue("Tessie");
      refuse = false;
      await page.getByLabel("confirmed with this person outside the site").check();
      await act(page, "add-new").click();
      await expect(page.locator("[data-hfy-result]")).toBeVisible();
      expect(s.posts.at(-1).body.preview.person.primary_name.nick).toBe("Tessie");
      expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("hfy-requests-draft:")))).toEqual([]);
    });

    test("the tabs list their own states", async ({ page }) => {
      const s = await open(page, {});
      await tab(page, "tree").click();
      await expect(items(page)).toHaveCount(1);
      await tab(page, "done").click();
      await expect(items(page)).toHaveCount(1);
      await expect(items(page).first()).toContainText("let in");
      expect(s.calls.map((c) => c.query.state).filter(Boolean)).toEqual(["pending", "awaiting_record", "done"]);
    });
  });
}

test.describe("the gear and the hub", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  const SHELL = { shellV2: true, navMe: true };

  test("the gear shows a dot and 'settings, N family requests waiting' for an admin, and the count falls after a decision", async ({ page }) => {
    const s = await open(page, { flags: SHELL, badge: 2 }, "?id=req1");
    const gear = page.locator("a.hfy-gear");
    await expect(gear).toHaveAttribute("aria-label", "settings, 2 family requests waiting");
    await expect(gear.locator("[data-hfy-gear-dot]")).toHaveCount(1);
    await page.locator('[data-hfy-candidate="I9001"] [data-hfy-act="its-them"]').click();
    await page.getByLabel("confirmed with this person outside the site").check();
    await act(page, "let-in").click();
    await expect(gear).toHaveAttribute("aria-label", "settings, 1 family request waiting");
    expect(s.meCalls).toBeGreaterThan(1);
    expect(await axeViolations(page)).toEqual([]);
  });

  test("with nothing waiting the gear is plain, and with the flag off /api/me is not asked for it", async ({ page }) => {
    await open(page, { flags: SHELL, badge: 0 });
    await expect(page.locator("a.hfy-gear")).toHaveAttribute("aria-label", "settings");
    await expect(page.locator("[data-hfy-gear-dot]")).toHaveCount(0);
    const page2 = await page.context().newPage();
    const s2 = await stub(page2, { flags: { ...SHELL, accessRequests: false } });
    await page2.goto("/me/", { waitUntil: "domcontentloaded" });
    await expect(page2.locator("a.hfy-gear")).toHaveAttribute("aria-label", "settings");
    await page2.waitForTimeout(400);
    expect(s2.meCalls).toBe(0);
  });

  test("the hub shows 'family requests' for an admin with the count, and not for a member or with the flag off", async ({ page }) => {
    await stub(page, { flags: SHELL, badge: 2 });
    await page.goto("/me/", { waitUntil: "domcontentloaded" });
    const row = page.locator('.hfy-settings [data-hfy-setting="requests"]');
    await expect(row).toHaveAttribute("href", "/me/requests/");
    await expect(row).toHaveAccessibleDescription("2 waiting");
    const member = await page.context().newPage();
    await stub(member, { flags: SHELL, admin: false });
    await member.goto("/me/", { waitUntil: "domcontentloaded" });
    await expect(member.locator('.hfy-settings [data-hfy-setting="notifications"]')).toBeVisible();
    await expect(member.locator('.hfy-settings [data-hfy-setting="requests"]')).toHaveCount(0);
    const off = await page.context().newPage();
    await stub(off, { flags: { ...SHELL, accessRequests: false } });
    await off.goto("/me/", { waitUntil: "domcontentloaded" });
    await expect(off.locator('.hfy-settings [data-hfy-setting="notifications"]')).toBeVisible();
    await expect(off.locator('.hfy-settings [data-hfy-setting="requests"]')).toHaveCount(0);
  });

  test("an empty queue reads 'nobody waiting' in the hub", async ({ page }) => {
    await stub(page, { flags: SHELL, badge: 0 });
    await page.goto("/me/", { waitUntil: "domcontentloaded" });
    await expect(page.locator('.hfy-settings [data-hfy-setting="requests"]')).toHaveAccessibleDescription("nobody waiting");
  });
});
