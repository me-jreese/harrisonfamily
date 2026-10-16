// HFY-TSK-259 (review-island; flags proposalReview and recordEdit, and adminDelete for the duplicates tab): /me/review/ at 375 and 1280, axe clean. Tabs by viewer, the admin queue
// (oldest first, filter chips), the detail card (before -> after, word diff, conflict rows), approve / ask for changes / decline with If-Match and an
// Idempotency-Key, a 412 re-rendering the fresh card, the stale card and "edit then approve", the proposer's edit, withdraw and reply, and the
// 40/60 split from 64rem. Synthetic people only; /auth, /api, the flags file and the people index are stubbed by route interception.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/review.spec.mjs
import { test, expect } from "@playwright/test";
import { axeViolations } from "./axe.mjs";
import { ID, REBASE_CLEAN, REBASE_CONFLICT, view } from "./fixtures/proposals.mjs";

const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]];
const ME = { id: "I9003", label: "Admin Example" };
const MINE_ID = "I9001"; // the proposer of "my suggestions" (the viewer when signed in as them)
const PEOPLE = [{ grampsId: "I9001", displayName: "Sam Example" }, { grampsId: "I9002", displayName: "Tessa Example" }, { grampsId: "I9003", displayName: "Admin Example" }];

const FLAGS = { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: false, profileLinks: false, recordSubsV1: false };

/**
 * The stubbed world. `admin`: the viewer is an admin; `session`: their id. `proposals`: the store (id -> ProposalView). `details`: id -> {rebase} extras.
 * `decision(req, s)` may answer a decision POST itself; the default applies the verdict. Every request to /api/proposals* is recorded.
 */
async function stub(page, { flags = { proposalReview: true, recordEdit: true }, admin = true, session = ME.id, proposals = [], rebase = {}, decision = null, patch = null, withdraw = null, editing = true } = {}) {
  const s = { requests: [], decisions: [], patches: [], withdraws: [], bundles: [], islandRequests: [], store: new Map(proposals.map((p) => [p.id, p])), rebase };
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { ...FLAGS, ...flags } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: session ? { authenticated: true, sub: session, grampsId: session, label: "Example" } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: PEOPLE } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route(/\/js\/islands\/review\./, (r) => { s.islandRequests.push(r.request().url()); return r.continue(); });
  await page.route("**/api/me", (r) => r.fulfill(session ? { json: { id: session, label: "Example", admin, can: {}, editing } } : { status: 401, json: { error: "unauthenticated" } }));
  await page.route("**/api/comments**", (r) => r.fulfill({ json: { thread: { id: "x", topic: "comments", comments: [], reactions: {} } } }));
  await page.route("**/api/edit/Person/*", (r) => { s.bundles.push(new URL(r.request().url()).pathname); return r.fulfill({ json: { key: "Person:hsyn0002", version: 9, etag: "Person:hsyn0002@9", obj: { _class: "Person", handle: "hsyn0002", primary_name: { first_name: "Tessie" } }, related: {} } }); });
  await page.route(/\/api\/proposals/, async (r) => {
    const req = r.request();
    const u = new URL(req.url());
    const headers = await req.allHeaders();
    const rec = { method: req.method(), path: u.pathname, search: u.search, query: Object.fromEntries(u.searchParams), headers, body: req.postData() ? JSON.parse(req.postData()) : undefined };
    s.requests.push(rec);
    const parts = u.pathname.split("/").filter(Boolean); // api, proposals, id?, action?
    if (parts.length === 2 && req.method() === "GET") {
      const v = rec.query.view;
      if (v === "queue" && !admin) return r.fulfill({ status: 403, json: { error: "not_admin", message: "only an admin can see the queue" } });
      const states = rec.query.state ? [rec.query.state] : ["pending", "stale"];
      const items = [...s.store.values()].filter((p) => states.includes(p.state) && (v === "queue" || (v === "mine" ? p.proposer.id === session : p.about === true)));
      return r.fulfill({ json: { items: items.map(({ about, ...p }) => p).reverse() } }); // the API's own order is irrelevant: the island sorts
    }
    const id = parts[2];
    const p = s.store.get(id);
    if (!p) return r.fulfill({ status: 404, json: { error: "not_found", message: "no such suggestion" } });
    if (parts.length === 3 && req.method() === "GET") return r.fulfill({ json: { ...p, rebase: s.rebase[id] || REBASE_CLEAN } });
    if (parts[3] === "decision") {
      s.decisions.push(rec);
      if (decision) { const a = await decision(rec, s, p); if (a) return r.fulfill(a); }
      const state = rec.body.verdict === "approve" ? "approved" : rec.body.verdict === "deny" ? "declined" : "needs_changes";
      const next = { ...p, state, rev: p.rev + 1, etag: `${p.etag}x`, decision: { verdict: rec.body.verdict, reason: rec.body.reason, by: { id: ME.id, label: ME.label }, at: p.created_at }, can: { ...p.can, decide: false } };
      s.store.set(id, next);
      return r.fulfill({ json: { proposal: next, ...(state === "approved" ? { applied: { versions: { "Person:hsyn0002": 10 } } } : {}) } });
    }
    if (parts[3] === "withdraw") {
      s.withdraws.push(rec);
      if (withdraw) { const a = await withdraw(rec, s, p); if (a) return r.fulfill(a); }
      const next = { ...p, state: "withdrawn", etag: `${p.etag}w`, can: { amend: false, withdraw: false, decide: false, comment: true } };
      s.store.set(id, next);
      return r.fulfill({ json: next });
    }
    if (parts.length === 3 && req.method() === "PATCH") {
      s.patches.push(rec);
      if (patch) { const a = await patch(rec, s, p); if (a) return r.fulfill(a); }
      const next = { ...p, rev: p.rev + 1, etag: `${p.etag}p`, ops: rec.body.ops, note: rec.body.note ?? p.note, state: "pending" };
      s.store.set(id, next);
      return r.fulfill({ json: next });
    }
    return r.fulfill({ status: 404, json: { error: "not_found" } });
  });
  return s;
}

const open = async (page, opts, query = "") => {
  const s = await stub(page, opts);
  await page.goto(`/me/review/${query}`, { waitUntil: "domcontentloaded" });
  return s;
};
const tab = (page, id) => page.locator(`[data-hfy-tab="${id}"]`);
const rows = (page) => page.locator("[data-hfy-items] > li");
const card = (page) => page.locator("[data-hfy-proposal-card]");
const act = (page, a) => card(page).locator(`[data-hfy-act="${a}"]`);
const mark = (n) => rows(n);

// three waiting suggestions about page I9002 from I9001, created out of order; ids are ULID-like so id order is creation order
const three = () => [view(3, { proposer: { id: "I9001", label: "Sam Example" } }), view(1), view(2, { note: "she goes by Tessa now" })];

test.describe("flags off", () => {
  test("no review bundle is requested and the page keeps its note", async ({ page }) => {
    const s = await open(page, { flags: { proposalReview: false, recordEdit: false } });
    await page.waitForTimeout(500);
    await expect(page.locator("[data-review-off]")).toHaveText("suggestions aren't available yet.");
    expect(s.islandRequests).toEqual([]);
    expect(s.requests).toEqual([]);
  });
});

test("signed out: the sign-in line, and no suggestions are asked for", async ({ page }) => {
  const s = await open(page, { session: null });
  await expect(page.locator("[data-hfy-gate]")).toContainText("sign in to see suggestions.");
  await expect(page.locator("[data-hfy-gate] a")).toHaveAttribute("href", /^\/auth\/login\?returnTo=/);
  expect(s.requests).toEqual([]);
});

test("with editing off at the API the page says so", async ({ page }) => {
  await open(page, { editing: false });
  await expect(page.locator(".hfy-reviewpage")).toContainText("suggestions aren't turned on yet.");
});

test("a member never sees the 'to review' tab, and the queue is never asked for (AC4)", async ({ page }) => {
  const s = await open(page, { admin: false, session: MINE_ID, proposals: three() }, "?tab=review");
  await expect(page.locator("[data-hfy-review-ready]")).toBeVisible();
  await expect(tab(page, "review")).toHaveCount(0);
  await expect(tab(page, "mine")).toHaveText("my suggestions");
  await expect(tab(page, "about")).toHaveText("about my page");
  await expect(tab(page, "mine")).toHaveAttribute("aria-current", "page"); // ?tab=review falls back to the first tab they have
  await expect(page.locator('[data-hfy-chip="waiting"]')).toHaveCount(0);
  expect(s.requests.filter((r) => r.query.view === "queue")).toEqual([]);
});

test("proposalReview alone: an admin gets only the queue; a member gets the 'not available' line", async ({ page }) => {
  await open(page, { flags: { proposalReview: true, recordEdit: false }, admin: true, proposals: three() });
  await expect(tab(page, "review")).toBeVisible();
  await expect(tab(page, "mine")).toHaveCount(0);
});

test("proposalReview alone and not an admin: nothing to show", async ({ page }) => {
  await open(page, { flags: { proposalReview: true, recordEdit: false }, admin: false, session: MINE_ID });
  await expect(page.locator(".hfy-reviewpage")).toContainText("suggestions aren't available yet.");
});

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("the admin queue lists oldest first with the chips, names as links, and is axe clean (AC1, AC5)", async ({ page }) => {
      await open(page, { proposals: three() });
      await expect(tab(page, "review")).toHaveText("to review");
      await expect(tab(page, "review")).toHaveAttribute("aria-current", "page");
      await expect(rows(page)).toHaveCount(3);
      const ids = await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-hfy-proposal-id")));
      expect(ids).toEqual([ID(1), ID(2), ID(3)]);
      await expect(page.locator("[data-hfy-chip]")).toHaveText(["waiting", "needs changes", "out of date", "done"]);
      await expect(page.locator('[data-hfy-chip="waiting"]')).toHaveAttribute("aria-pressed", "true");
      const first = rows(page).first();
      await expect(first.locator("[data-hfy-kind]")).toHaveText("edit");
      await expect(first.locator(".hfy-review__first")).toContainText("change the first name");
      await expect(first.locator(".hfy-review__age")).toHaveText(/ago|\w{3} \d/);
      // P2-R46: both names are links to the person page, no underline, the text's own colour and weight
      const who = first.locator("a.hfy-person-name");
      await expect(who).toHaveCount(2);
      await expect(who.nth(0)).toHaveAttribute("href", "/person/?id=I9001");
      await expect(who.nth(0)).toHaveText("Sam Example");
      await expect(who.nth(1)).toHaveAttribute("href", "/person/?id=I9002");
      await expect(who.nth(1)).toHaveText("Tessa Example");
      expect(await who.nth(0).evaluate((a) => getComputedStyle(a).textDecorationLine)).toBe("none");
      const opener = first.getByRole("button");
      expect((await opener.boundingBox()).height).toBeGreaterThanOrEqual(44);
      expect(await axeViolations(page)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });

    test("the out-of-date chip lists a suggestion whose page moved; the done chip lists the finished ones", async ({ page }) => {
      await open(page, { proposals: [view(1), view(2, { stale: true }), view(3, { state: "stale" }), view(4, { state: "approved" }), view(5, { state: "declined", decision: { verdict: "deny", reason: "x" } })] });
      await expect(rows(page)).toHaveCount(1);
      await page.locator('[data-hfy-chip="out-of-date"]').click();
      await expect(rows(page)).toHaveCount(2);
      await expect(rows(page).first().locator(".hfy-review__chip")).toHaveText("out of date");
      await page.locator('[data-hfy-chip="done"]').click();
      await expect(rows(page)).toHaveCount(2);
      await page.locator('[data-hfy-chip="needs-changes"]').click();
      await expect(page.locator("[data-hfy-empty]")).toHaveText("nothing here yet.");
    });

    test("an empty queue says so", async ({ page }) => {
      await open(page, { proposals: [] });
      await expect(page.locator("[data-hfy-empty]")).toHaveText("nothing is waiting for review.");
      expect(await axeViolations(page)).toEqual([]);
    });

    test("the card: per-op before and after with a word diff, the note, the comment thread; axe clean", async ({ page }) => {
      const p = view(2, {
        note: "she goes by Tessa now",
        ops: [{ id: "names.first_name", op: "set", obj: "Person:hsyn0002", path: "/primary_name/first_name", base: "Anna Marie", value: "Anna Maria Lee" }],
        summary: [{ text: "change the first name from \"Anna Marie\" to \"Anna Maria Lee\"", opIds: ["names.first_name"] }],
        warnings: ["there may be another person with this name"],
      });
      await open(page, { proposals: [p] });
      await rows(page).first().getByRole("button").click();
      const c = card(page);
      await expect(c).toBeVisible();
      await expect(c.getByRole("heading", { level: 2 }).first()).toContainText("change the first name");
      await expect(c.locator(".hfy-review__before")).toContainText("Anna Marie");
      await expect(c.locator(".hfy-review__after")).toContainText("Anna Maria Lee");
      await expect(c.locator("[data-hfy-diff] del")).toHaveText("Marie");
      await expect(c.locator("[data-hfy-diff] ins")).toHaveText("Maria Lee");
      await expect(c.locator("[data-hfy-note]")).toHaveText("she goes by Tessa now");
      await expect(c.getByText("there may be another person with this name")).toBeVisible();
      await expect(c.locator("[data-hfy-comments]")).toBeVisible();
      for (const a of ["approve", "ask", "decline", "edit"]) expect((await act(page, a).boundingBox()).height).toBeGreaterThanOrEqual(44);
      await expect(c.locator("a.hfy-person-name").first()).toHaveAttribute("href", /\/person\/\?id=I90/);
      expect(await axeViolations(page)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });

    test("approve sends If-Match and an Idempotency-Key; the card then reads 'added to the family tree' (AC2)", async ({ page }) => {
      const s = await open(page, { proposals: [view(1)] });
      await rows(page).first().getByRole("button").click();
      await expect(act(page, "approve")).toBeEnabled();
      await act(page, "approve").click();
      await expect(card(page).locator("[data-hfy-notice]")).toHaveText("added to the family tree.");
      expect(s.decisions).toHaveLength(1);
      const d = s.decisions[0];
      expect(d.headers["if-match"]).toBe(`"${view(1).etag}"`);
      expect(d.headers["idempotency-key"]).toMatch(new RegExp(`^${ID(1)}:approve:`));
      expect(d.body).toEqual({ verdict: "approve" });
      await expect(card(page)).toHaveAttribute("data-state", "approved");
      await expect(card(page).locator("[data-hfy-actions]")).toHaveCount(0);
    });

    test("decline needs text, then sends deny with the reason, If-Match and an Idempotency-Key (AC2)", async ({ page }) => {
      const s = await open(page, { proposals: [view(1)] });
      await rows(page).first().getByRole("button").click();
      await act(page, "decline").click();
      const sheet = page.locator("[data-hfy-reason-sheet='decline']");
      await expect(sheet).toBeVisible();
      await expect(sheet.locator("[data-hfy-reason-send]")).toBeDisabled();
      await sheet.getByLabel("why isn't it being added?").fill("   ");
      await expect(sheet.locator("[data-hfy-reason-send]")).toBeDisabled();
      expect(await axeViolations(page)).toEqual([]);
      await sheet.getByLabel("why isn't it being added?").fill("that is a different cousin");
      await sheet.locator("[data-hfy-reason-send]").click();
      await expect(card(page)).toHaveAttribute("data-state", "declined");
      expect(s.decisions).toHaveLength(1);
      expect(s.decisions[0].body).toEqual({ verdict: "deny", reason: "that is a different cousin" });
      expect(s.decisions[0].headers["if-match"]).toBe(`"${view(1).etag}"`);
      expect(s.decisions[0].headers["idempotency-key"]).toMatch(new RegExp(`^${ID(1)}:deny:`));
    });

    test("ask for changes needs text, then sends needs_changes with the message (AC2)", async ({ page }) => {
      const s = await open(page, { proposals: [view(1)] });
      await rows(page).first().getByRole("button").click();
      await act(page, "ask").click();
      const sheet = page.locator("[data-hfy-reason-sheet='ask']");
      await expect(sheet.locator("[data-hfy-reason-send]")).toBeDisabled();
      await sheet.getByLabel("what would you like changed?").fill("which Tess do you mean?");
      await sheet.locator("[data-hfy-reason-send]").click();
      await expect(card(page)).toHaveAttribute("data-state", "needs_changes");
      expect(s.decisions[0].body).toEqual({ verdict: "needs_changes", reason: "which Tess do you mean?" });
      expect(s.decisions[0].headers["if-match"]).toBe(`"${view(1).etag}"`);
      expect(s.decisions[0].headers["idempotency-key"]).toMatch(new RegExp(`^${ID(1)}:needs_changes:`));
    });

    test("a 412 re-renders the fresh card instead of failing (AC2)", async ({ page }) => {
      const fresh = view(1, { rev: 2, etag: "freshetag00000000", note: "edited just now by the proposer" });
      const s = await open(page, {
        proposals: [view(1)],
        decision: async (rec, st) => { st.store.set(ID(1), fresh); return { status: 412, json: { error: "precondition_failed", message: "this suggestion changed since you opened it", details: { proposal: fresh } } }; },
      });
      await rows(page).first().getByRole("button").click();
      await expect(card(page).locator("[data-hfy-note]")).toHaveCount(0);
      await act(page, "approve").click();
      await expect(card(page).locator("[data-hfy-note]")).toHaveText("edited just now by the proposer");
      await expect(card(page).locator("[data-hfy-problem]")).toContainText("this suggestion changed while you looked");
      expect(s.decisions).toHaveLength(1);
      // the next approve goes out against the fresh etag
      await act(page, "approve").click();
      await expect.poll(() => s.decisions.length).toBe(2);
      expect(s.decisions[1].headers["if-match"]).toBe('"freshetag00000000"');
    });

    test("a destructive approval says the admin will be asked to sign in again; a step-up refusal links a fresh sign-in", async ({ page }) => {
      const gone = view(1, { ops: [{ id: "x", op: "remove", obj: "Family:hfam0001", path: "/child_ref_list/@ref=hsyn0002", base_hash: "0".repeat(64) }], summary: [{ text: "remove a child from a family", opIds: ["x"] }] });
      await open(page, {
        proposals: [gone],
        decision: async () => ({ status: 401, json: { error: "step_up_required", message: "this change needs a fresh sign-in", details: { maxAgeSeconds: 900 } } }),
      });
      await rows(page).first().getByRole("button").click();
      await expect(card(page).locator("[data-hfy-stepup]")).toHaveText("you'll be asked to sign in again to confirm.");
      await act(page, "approve").click();
      const link = card(page).locator("[data-hfy-problem] a");
      await expect(link).toHaveText("sign in again to confirm");
      expect(await link.getAttribute("href")).toMatch(/^\/auth\/login\?prompt=login&returnTo=%2Fme%2Freview%2F/);
    });

    test("a stale card shows per-op conflict rows and disables approve until 'edit then approve' saves an amend (AC3)", async ({ page }) => {
      const p = view(1, { stale: true, ops: [{ id: "names.first_name", op: "set", obj: "Person:hsyn0002", path: "/primary_name/first_name", base: "Tess", value: "Tessa Marie" }] });
      const s = await open(page, { proposals: [p], rebase: { [ID(1)]: REBASE_CONFLICT } });
      await page.locator('[data-hfy-chip="out-of-date"]').click();
      await rows(page).first().getByRole("button").click();
      const c = card(page);
      await expect(c).toHaveAttribute("data-hfy-rebase", "conflict");
      const conflicts = c.locator("[data-hfy-conflict]");
      await expect(conflicts).toHaveCount(1);
      await expect(conflicts.locator("dd")).toHaveText(["Tess", "Tessie", "Tessa Marie"]);
      await expect(act(page, "approve")).toBeDisabled();
      await expect(c.locator("[data-hfy-blocked]")).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      // edit then approve: pick what to keep first; the send stays off until every conflict has a choice
      await act(page, "edit").click();
      const form = c.locator("[data-hfy-amend]");
      await expect(form).toBeVisible();
      await expect(form.locator("[data-hfy-amend-send]")).toBeDisabled();
      await form.getByLabel("keep their suggestion", { exact: false }).check();
      await form.getByLabel("they suggested").fill("Tessa Maria");
      await expect(form.locator("[data-hfy-amend-send]")).toBeEnabled();
      expect(await axeViolations(page)).toEqual([]);
      await form.locator("[data-hfy-amend-send]").click();
      await expect(c).toHaveAttribute("data-state", "approved");
      expect(s.decisions).toHaveLength(1);
      expect(s.decisions[0].headers["if-match"]).toBe(`"${p.etag}"`);
      expect(s.decisions[0].headers["idempotency-key"]).toBeTruthy();
      expect(s.decisions[0].body).toEqual({
        verdict: "approve",
        amend: { ops: [{ id: "names.first_name", op: "set", obj: "Person:hsyn0002", path: "/primary_name/first_name", base: "Tessie", value: "Tessa Maria" }], base_versions: { "Person:hsyn0002": 9 } },
      });
      expect(s.bundles).toContain("/api/edit/Person/h%3Ahsyn0002");
    });

    test("a clean rebase says the suggestion still applies and keeps approve on", async ({ page }) => {
      await open(page, { proposals: [view(1, { stale: true })], rebase: { [ID(1)]: REBASE_CLEAN } });
      await page.locator('[data-hfy-chip="out-of-date"]').click();
      await rows(page).first().getByRole("button").click();
      await expect(card(page).locator("[data-hfy-clean]")).toHaveText("the page changed since; this suggestion still applies.");
      await expect(act(page, "approve")).toBeEnabled();
    });

    test("a rebase_conflict on approve turns the card into the conflict card", async ({ page }) => {
      const p = view(1);
      const s = await open(page, {
        proposals: [p],
        decision: async (rec, st) => {
          st.rebase[ID(1)] = REBASE_CONFLICT;
          st.store.set(ID(1), { ...p, state: "stale", etag: "staleetag0000000", stale: true, updated_at: "2026-03-09T11:00:00.000Z" });
          return { status: 409, json: { error: "rebase_conflict", message: "the page changed" } };
        },
      });
      await rows(page).first().getByRole("button").click();
      await act(page, "approve").click();
      await expect(card(page)).toHaveAttribute("data-hfy-rebase", "conflict");
      await expect(act(page, "approve")).toBeDisabled();
      await expect(card(page).locator("[data-hfy-problem]")).toContainText("the page changed again");
      expect(s.decisions).toHaveLength(1);
    });

    test("my suggestions: state chips in plain words; edit, withdraw and reply on my own (AC4)", async ({ page }) => {
      const mine = (n, over = {}) => view(n, { proposer: { id: MINE_ID, label: "Sam Example" }, can: { amend: true, withdraw: true, decide: false, comment: true }, ...over });
      const s = await open(page, {
        admin: false, session: MINE_ID,
        proposals: [mine(1), mine(2, { state: "needs_changes" }), mine(3, { state: "stale" }), mine(4, { state: "approved", can: { amend: false, withdraw: false, decide: false, comment: true } }), view(5, { proposer: { id: "I9009", label: "Other Example" } })],
      });
      await expect(tab(page, "mine")).toHaveAttribute("aria-current", "page");
      await expect(rows(page)).toHaveCount(3);
      await expect(rows(page).locator(".hfy-review__chip")).toHaveText(["needs a quick update — the page changed", "an admin asked a question", "waiting for review"]);
      await page.locator('[data-hfy-chip="done"]').click();
      await expect(rows(page).locator(".hfy-review__chip")).toHaveText(["added to the family tree"]);
      await page.locator('[data-hfy-chip="open"]').click();
      expect(await axeViolations(page)).toEqual([]);
      // newest first: the stale one (3) is on top; open the waiting one (1)
      await rows(page).nth(2).getByRole("button").click();
      await expect(card(page)).toHaveAttribute("data-mode", "mine");
      await expect(act(page, "approve")).toHaveCount(0);
      await expect(act(page, "decline")).toHaveCount(0);
      await expect(card(page).locator("[data-hfy-comments]")).toBeVisible();
      // edit: change the value and the note, saved with PATCH and If-Match
      await act(page, "edit").click();
      const form = card(page).locator("[data-hfy-amend]");
      await expect(form.locator("[data-hfy-amend-send]")).toBeEnabled();
      await form.getByLabel("they suggested").fill("Tessa");
      await form.getByLabel("a note for whoever looks at it (optional)").fill("shorter, please");
      await form.locator("[data-hfy-amend-send]").click();
      await expect(card(page).locator("[data-hfy-notice]")).toContainText("saved.");
      expect(s.patches).toHaveLength(1);
      expect(s.patches[0].headers["if-match"]).toBe(`"${mine(1).etag}"`);
      expect(s.patches[0].body.note).toBe("shorter, please");
      expect(s.patches[0].body.ops[0].value).toBe("Tessa");
      expect(s.patches[0].body.base_versions).toEqual({ "Person:hsyn0002": 9 });
    });

    test("withdraw asks first, then posts with If-Match", async ({ page }) => {
      const mine = view(1, { proposer: { id: MINE_ID, label: "Sam Example" }, can: { amend: true, withdraw: true, decide: false, comment: true } });
      const s = await open(page, { admin: false, session: MINE_ID, proposals: [mine] });
      await rows(page).first().getByRole("button").click();
      await act(page, "withdraw").click();
      await expect(card(page).locator("[data-hfy-confirm]")).toContainText("withdraw this suggestion?");
      await act(page, "withdraw-keep").click();
      await expect(card(page).locator("[data-hfy-confirm]")).toHaveCount(0);
      expect(s.withdraws).toHaveLength(0);
      await act(page, "withdraw").click();
      await act(page, "withdraw-yes").click();
      await expect(card(page)).toHaveAttribute("data-state", "withdrawn");
      expect(s.withdraws).toHaveLength(1);
      expect(s.withdraws[0].headers["if-match"]).toBe(`"${mine.etag}"`);
      expect(s.withdraws[0].path).toBe(`/api/proposals/${ID(1)}/withdraw`);
    });

    test("a relationship suggestion cannot be edited, only withdrawn", async ({ page }) => {
      const mine = view(1, { kind: "relationship", proposer: { id: MINE_ID, label: "Sam Example" }, summary: ["adds a person as a child of two people"], can: { amend: true, withdraw: true, decide: false, comment: true } });
      await open(page, { admin: false, session: MINE_ID, proposals: [mine] });
      await rows(page).first().getByRole("button").click();
      await expect(card(page).locator("[data-hfy-kind]")).toHaveText("family connection");
      await expect(card(page)).toContainText("adds a person as a child of two people");
      await expect(act(page, "edit")).toHaveCount(0);
      await expect(act(page, "withdraw")).toBeVisible();
    });

    test("about my page: read only, newest first, with the thread", async ({ page }) => {
      const about = (n) => view(n, { about: true, can: { amend: false, withdraw: false, decide: false, comment: true } });
      const s = await open(page, { admin: false, session: "I9002", proposals: [about(1), about(2)] }, "?tab=about");
      await expect(tab(page, "about")).toHaveAttribute("aria-current", "page");
      await expect(rows(page)).toHaveCount(2);
      expect(await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-hfy-proposal-id")))).toEqual([ID(2), ID(1)]);
      await rows(page).first().getByRole("button").click();
      await expect(card(page)).toHaveAttribute("data-mode", "about");
      await expect(card(page).locator("[data-hfy-actions]")).toHaveCount(0);
      await expect(card(page).locator("[data-hfy-comments]")).toBeVisible();
      expect(s.requests.filter((r) => r.query.view === "about-me")).not.toHaveLength(0);
      expect(await axeViolations(page)).toEqual([]);
    });

    test("a retry after a lost answer sends the same Idempotency-Key and gets the first result back", async ({ page }) => {
      let applied = null;
      const s = await open(page, {
        proposals: [view(1)],
        decision: async (rec, st, p) => {
          const key = rec.headers["idempotency-key"];
          if (!applied) {
            applied = { key, next: { ...p, state: "approved", rev: p.rev + 1, etag: `${p.etag}x`, can: { ...p.can, decide: false } } };
            st.store.set(p.id, applied.next);
            return { status: 503, json: { error: "unavailable", message: "busy" } }; // the decision committed, the answer was lost
          }
          if (key === applied.key) return { status: 200, json: { proposal: applied.next } }; // a replay of the same request
          return { status: 412, json: { error: "precondition_failed", message: "changed", details: { proposal: applied.next } } };
        },
      });
      await rows(page).first().getByRole("button").click();
      await act(page, "approve").click();
      await expect(card(page).locator("[data-hfy-problem]")).toBeVisible();
      await act(page, "approve").click();
      await expect(card(page).locator("[data-hfy-notice]")).toHaveText("added to the family tree.");
      expect(s.decisions).toHaveLength(2);
      expect(s.decisions[1].headers["idempotency-key"]).toBe(s.decisions[0].headers["idempotency-key"]);
    });

    test("a card whose detail did not load says so and can try again", async ({ page }) => {
      let fail = true;
      const s = await open(page, { proposals: [view(1)] });
      await page.route(new RegExp(`/api/proposals/${ID(1)}$`), (r) => {
        if (r.request().method() === "GET" && fail) { fail = false; return r.fulfill({ status: 503, json: { error: "unavailable" } }); }
        return r.fallback();
      });
      await rows(page).first().getByRole("button").click();
      await expect(card(page).locator("[data-hfy-detail-failed]")).toContainText("didn't load");
      await expect(act(page, "approve")).toBeDisabled();
      await card(page).locator('[data-hfy-act="retry-detail"]').click();
      await expect(card(page).locator("[data-hfy-detail-failed]")).toHaveCount(0);
      await expect(act(page, "approve")).toBeEnabled();
      expect(s.requests.filter((r) => r.method === "GET" && r.path.endsWith(`/${ID(1)}`)).length).toBeGreaterThanOrEqual(1);
    });

    test("a link to one suggestion (?p=) opens it even when it is not on the list", async ({ page }) => {
      await open(page, { proposals: [view(1, { state: "approved" })] }, `?tab=review&p=${ID(1)}`);
      await expect(card(page)).toBeVisible();
      await expect(card(page)).toHaveAttribute("data-state", "approved");
    });

    test("a link to a suggestion that is not there says so", async ({ page }) => {
      await open(page, { proposals: [] }, `?tab=review&p=${ID(9)}`);
      await expect(page.locator("[data-hfy-detail]")).toContainText("we couldn't find that suggestion.");
    });
  });
}

test.describe("the layout", () => {
  test("375: the list and the card are two views; back returns to the list with the sticky actions in between", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page, { proposals: three() });
    await expect(page.locator("[data-hfy-list]")).toBeVisible();
    await expect(page.locator("[data-hfy-detail]")).toHaveCount(0);
    await rows(page).first().getByRole("button").click();
    await expect(page.locator("[data-hfy-list]")).toHaveCount(0);
    await expect(card(page)).toBeVisible();
    expect(new URL(page.url()).searchParams.get("p")).toBe(ID(1));
    expect(await page.locator("[data-hfy-actions]").evaluate((e) => getComputedStyle(e).position)).toBe("sticky");
    await page.locator("[data-hfy-back]").click();
    await expect(page.locator("[data-hfy-list]")).toBeVisible();
    expect(new URL(page.url()).searchParams.get("p")).toBeNull();
    await rows(page).first().getByRole("button").click();
    await page.goBack();
    await expect(page.locator("[data-hfy-list]")).toBeVisible();
  });

  test("375: opening and closing a card does not grow the history", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page, { proposals: three() });
    await expect(rows(page)).toHaveCount(3);
    const before = await page.evaluate(() => history.length);
    for (let i = 0; i < 3; i += 1) {
      await rows(page).first().getByRole("button").click();
      await expect(card(page)).toBeVisible();
      await page.locator("[data-hfy-back]").click();
      await expect(page.locator("[data-hfy-list]")).toBeVisible();
    }
    expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(before + 1);
    await page.goBack(); // leaves the page entirely: the list is not reopened as a card
    await expect(page.locator("[data-hfy-detail]")).toHaveCount(0);
  });

  for (const [width, split] of [[1023, false], [1024, true], [1280, true]]) {
    test(`${width}: ${split ? "a 40/60 list and detail split" : "a single column"}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, { proposals: three() });
      await expect(page.locator("[data-hfy-list]")).toBeVisible();
      const cols = await page.locator(".hfy-review__split").evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(" ").filter(Boolean).map(parseFloat));
      if (!split) {
        expect(cols).toHaveLength(1);
        await expect(page.locator("[data-hfy-detail]")).toHaveCount(0);
        return;
      }
      await expect(page.locator("[data-hfy-detail]")).toBeVisible();
      await expect(page.locator("[data-hfy-pick]")).toHaveText("pick a suggestion to look at it.");
      expect(cols).toHaveLength(2);
      const gap = await page.locator(".hfy-review__split").evaluate((e) => parseFloat(getComputedStyle(e).columnGap));
      const share = cols[0] / (cols[0] + cols[1]);
      expect(share).toBeGreaterThan(0.39);
      expect(share).toBeLessThan(0.41);
      expect(gap).toBeGreaterThan(0);
      // a card opens beside the list, the list stays
      await rows(page).first().getByRole("button").click();
      await expect(card(page)).toBeVisible();
      await expect(page.locator("[data-hfy-list]")).toBeVisible();
      await expect(page.locator("[data-hfy-back]")).toHaveCount(0);
      expect(await axeViolations(page)).toEqual([]);
    });
  }
});
