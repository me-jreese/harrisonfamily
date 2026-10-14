// HFY-TSK-213 (flag recordEdit): the editor's save flow at 375 and 1280: the sticky bar, the dry-run confirmation sheet, save, undo, and the 409 refetch-and-replay.
// Synthetic people only. /auth, /api, the flags file and the person JSON are stubbed; /api/changes is a small in-memory fake that applies the direct
// ops (given names go to review for a member, everything else saves now), so the requests the page sends are the ones checked.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/editor-save.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";
import { EDIT_SCHEMAS } from "../src/lib/edit-schemas.js";

const POLICY = JSON.parse(readFileSync(new URL("./fixtures/edit-policy-person.json", import.meta.url), "utf8"));
const KEY = "Person:hsyn0001";
const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]];
const LABELS = { first_name: "given names", call: "name you go by", nick: "nickname", title: "title", suffix: "suffix" };

const objWith = (names) => ({ _class: "Person", handle: "hsyn0001", gramps_id: "I9001", primary_name: { _class: "Name", first_name: "Test", nick: "Tess", surname_list: [{ _class: "Surname", surname: "Person", primary: true }], ...names } });

/** The flags, session, /api/me, /api/edit and /api/changes in memory. `server` is the fake store; `script(req, n)` may answer a /changes call itself. */
async function stub(page, { admin = false, relation = "own", script = null } = {}) {
  const server = { obj: objWith({}), version: 4, calls: [], bundleGets: 0, script };
  const bundle = () => ({ key: KEY, version: server.version, etag: `${KEY}@${server.version}`, obj: server.obj, related: {}, relation, viewer: { admin }, policy: POLICY, pending: [], customTypes: {}, schemaHash: "0".repeat(64) });
  const lastProp = (path) => path.split("/").pop();
  const sentence = (op) => `change the ${LABELS[lastProp(op.path)]} from ${op.base ?? "nothing"} to ${op.value || "nothing"}`;
  const reviewOp = (op) => !admin && lastProp(op.path) === "first_name";
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: false, profileLinks: false, recordSubsV1: false, recordEdit: true } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: "I9001", grampsId: "I9001", label: "Sam Example" } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { id: "I9001", label: "Sam Example", admin, can: {}, ownRecord: { cls: "Person", handle: "hsyn0001", gramps_id: "I9001" }, editing: true } }));
  await page.route("**/api/edit/schema/Person", (r) => r.fulfill({ json: { class: "Person", schema: EDIT_SCHEMAS.Person, sha256: "0".repeat(64), schemaHash: "0".repeat(64) } }));
  // `server.hold` (a promise) delays the bundle answers while set, to let a test type while the refetch after a save is still out.
  await page.route("**/api/edit/Person/*", async (r) => { server.bundleGets += 1; const snapshot = bundle(); if (server.hold) await server.hold; return r.fulfill({ json: snapshot }); });
  await page.route("**/api/changes", async (route) => {
    const req = route.request();
    const body = req.postDataJSON();
    const call = { body, key: req.headers()["idempotency-key"] };
    server.calls.push(call);
    const n = server.calls.length;
    if (server.script) {
      const answer = server.script(call, n, server);
      if (answer) return route.fulfill(answer);
    }
    const ops = body.ops;
    if (body.dry_run) {
      return route.fulfill({ json: {
        plan: {
          direct: ops.filter((o) => !reviewOp(o)).map((o) => ({ opIds: [o.id], summary: [{ text: sentence(o), opIds: [o.id] }] })),
          review: ops.filter(reviewOp).map((o) => ({ opIds: [o.id], summary: [{ text: sentence(o), opIds: [o.id] }] }))
        }, warnings: [], errors: []
      } });
    }
    const direct = ops.filter((o) => o.seq || !reviewOp(o));
    const review = ops.filter((o) => !o.seq && reviewOp(o));
    const inverse = [];
    for (const o of direct) {
      const name = lastProp(o.path);
      inverse.unshift({ id: `inv:${o.id}`, op: "set", obj: KEY, path: o.path, base: o.value, value: o.base ?? "", seq: true });
      server.obj = objWith({ ...server.obj.primary_name, [name]: o.value });
    }
    if (direct.length) server.version += 1;
    return route.fulfill({
      status: 201,
      json: {
        applied: direct.length ? { versions: { [KEY]: server.version }, undo: ops.every((o) => o.seq) ? null : { base_versions: { [KEY]: server.version }, ops: inverse } } : null,
        proposal: review.length ? { id: "P1", state: "pending" } : null,
        summary: [...direct.map((o) => ({ text: sentence(o), opIds: [o.id], route: "direct" })), ...review.map((o) => ({ text: sentence(o), opIds: [o.id], route: "review" }))]
      }
    });
  });
  return server;
}

const open = async (page, opts) => {
  const server = await stub(page, opts);
  await page.goto("/edit/?cls=person&id=I9001", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-hfy-editor-ready]")).toBeVisible();
  return server;
};
const field = (page, label) => page.getByLabel(label, { exact: true });
const sheet = (page) => page.locator("dialog.hfy-sheet");
const overflow = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return { sw: e.scrollWidth, cw: e.clientWidth }; }, sel);

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("no bar until something changes; the bar counts the changes by how they will be handled", async ({ page }) => {
      await open(page);
      await expect(page.locator("[data-hfy-bar]")).toHaveCount(0);
      await field(page, "nickname").fill("Tessa");
      await expect(page.locator("[data-hfy-bar-text]")).toHaveText("1 change — 1 saves now");
      await field(page, "given names").fill("Tester");
      await expect(page.locator("[data-hfy-bar-text]")).toHaveText("2 changes — 1 saves now, 1 goes to review");
      await field(page, "title").fill("Dr");
      await expect(page.locator("[data-hfy-bar-text]")).toHaveText("3 changes — 2 save now, 1 goes to review");
      // putting a value back removes the change
      await field(page, "title").fill("");
      await field(page, "nickname").fill("Tess");
      await expect(page.locator("[data-hfy-bar-text]")).toHaveText("1 change — 1 goes to review");
      await field(page, "given names").fill("Test");
      await expect(page.locator("[data-hfy-bar]")).toHaveCount(0);
    });

    test("the bar and the toast: 44 px targets, no horizontal scroll, axe clean", async ({ page }) => {
      await open(page);
      await field(page, "nickname").fill("Tessa");
      await expect(page.locator("[data-hfy-bar]")).toBeVisible();
      const heights = async (sel) => page.locator(sel).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
      for (const h of await heights("[data-hfy-bar] button")) expect(h).toBeGreaterThanOrEqual(44);
      const doc = await overflow(page, "html");
      expect(doc.sw).toBeLessThanOrEqual(doc.cw);
      expect(await axeViolations(page)).toEqual([]);
      await page.locator("[data-hfy-review]").click();
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(page.locator("[data-hfy-toast]")).toBeVisible();
      for (const h of await heights("[data-hfy-toast] button, [data-hfy-toast] a")) expect(h).toBeGreaterThanOrEqual(44);
      const after = await overflow(page, "html");
      expect(after.sw).toBeLessThanOrEqual(after.cw);
      expect(await axeViolations(page)).toEqual([]);
    });

    test("review: the dry run fills the sheet, grouped saves now and sent for review, with who reviews it; nothing is saved yet", async ({ page }) => {
      const server = await open(page);
      await field(page, "nickname").fill("Tessa");
      await field(page, "given names").fill("Tester");
      await page.locator("[data-hfy-review]").click();
      await expect(sheet(page)).toBeVisible();
      await expect(sheet(page).locator("h2")).toHaveText("check your changes");
      const direct = sheet(page).locator('[data-hfy-group="hfy-sheet-direct"]');
      const review = sheet(page).locator('[data-hfy-group="hfy-sheet-review"]');
      await expect(direct.locator("h3")).toHaveText("saves now");
      await expect(direct.locator("li")).toHaveText(["change the nickname from Tess to Tessa"]);
      await expect(review.locator("h3")).toHaveText("sent for review");
      await expect(review.locator("li")).toHaveText(["change the given names from Test to Tester"]);
      await expect(review.locator("[data-hfy-who]")).toContainText("an admin of the family site looks these over before they show");
      expect(server.calls).toHaveLength(1);
      expect(server.calls[0].body).toEqual({
        target: KEY, base_versions: { [KEY]: 4 }, dry_run: true,
        ops: [
          { id: "names.first_name", op: "set", obj: KEY, path: "/primary_name/first_name", base: "Test", value: "Tester" },
          { id: "names.nick", op: "set", obj: KEY, path: "/primary_name/nick", base: "Tess", value: "Tessa" }
        ]
      });
      expect(server.calls[0].key).toBeUndefined();
      // back closes it without saving, the edits stay
      await sheet(page).locator("[data-hfy-back]").click();
      await expect(sheet(page)).toBeHidden();
      await expect(field(page, "nickname")).toHaveValue("Tessa");
      expect(server.calls).toHaveLength(1);
    });

    test("the sheet: no horizontal scroll, 16 px inputs, 44 px targets, axe clean", async ({ page }) => {
      await open(page);
      await field(page, "nickname").fill("Tessa");
      await field(page, "given names").fill("Tester");
      await page.locator("[data-hfy-review]").click();
      await expect(sheet(page).locator('[data-hfy-group="hfy-sheet-review"]')).toBeVisible();
      const doc = await overflow(page, "html");
      expect(doc.sw).toBeLessThanOrEqual(doc.cw);
      const dlg = await overflow(page, "dialog.hfy-sheet");
      expect(dlg.sw).toBeLessThanOrEqual(dlg.cw);
      const box = await sheet(page).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      const inputs = await sheet(page).locator("input, textarea, select").evaluateAll((els) => els.map((e) => ({ fs: parseFloat(getComputedStyle(e).fontSize), h: e.getBoundingClientRect().height })));
      expect(inputs.length).toBeGreaterThan(0);
      for (const i of inputs) { expect(i.fs).toBeGreaterThanOrEqual(16); expect(i.h).toBeGreaterThanOrEqual(44); }
      const targets = await sheet(page).locator("button, a").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
      expect(targets.length).toBeGreaterThan(1);
      for (const h of targets) expect(h).toBeGreaterThanOrEqual(44);
      expect(await axeViolations(page)).toEqual([]);
      // Escape closes it, and focus goes back to the review button
      await page.keyboard.press("Escape");
      await expect(sheet(page)).toBeHidden();
      await expect(page.locator("[data-hfy-review]")).toBeFocused();
    });

    test("save: an Idempotency-Key, the same ops, the note, then a toast with undo and the suggestion count; undo sends the returned inverse ops", async ({ page }) => {
      const server = await open(page);
      await field(page, "nickname").fill("Tessa");
      await field(page, "given names").fill("Tester");
      await page.locator("[data-hfy-review]").click();
      await sheet(page).locator("[data-hfy-note]").fill("a synthetic note for the reviewer");
      await expect(sheet(page).locator("[data-hfy-note-count]")).toHaveText("33 of 1000 characters");
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(sheet(page)).toBeHidden();
      await expect(page.locator("[data-hfy-toast-text]")).toHaveText("saved. 1 suggestion sent");
      await expect(page.locator("[data-hfy-toast]")).toBeFocused();
      expect(server.calls).toHaveLength(2);
      const save = server.calls[1];
      expect(save.key).toMatch(/^[\x21-\x7e]{8,128}$/);
      expect(save.body.dry_run).toBeUndefined();
      expect(save.body.note).toBe("a synthetic note for the reviewer");
      expect(save.body.ops.map((o) => o.id)).toEqual(["names.first_name", "names.nick"]);
      // the page took the new record: the bar is gone and the nickname is the saved one
      await expect(page.locator("[data-hfy-bar]")).toHaveCount(0);
      await expect(field(page, "nickname")).toHaveValue("Tessa");
      await expect(page.locator("[data-hfy-toast] a")).toHaveAttribute("href", "/me/review/?tab=mine");
      // undo
      await page.locator("[data-hfy-undo]").click();
      await expect(page.locator("[data-hfy-toast-text]")).toHaveText("undone.");
      expect(server.calls).toHaveLength(3);
      expect(server.calls[2].body).toEqual({
        target: KEY, base_versions: { [KEY]: 5 },
        ops: [{ id: "inv:names.nick", op: "set", obj: KEY, path: "/primary_name/nick", base: "Tessa", value: "Tess", seq: true }]
      });
      expect(server.calls[2].key).not.toBe(save.key);
      await expect(field(page, "nickname")).toHaveValue("Tess");
      expect(await axeViolations(page)).toEqual([]);
    });

    test("edits made after a save survive the undo: the page is refetched with them laid over it", async ({ page }) => {
      const server = await open(page);
      await field(page, "nickname").fill("Tessa");
      await page.locator("[data-hfy-review]").click();
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(page.locator("[data-hfy-toast-text]")).toHaveText("saved.");
      await expect(field(page, "nickname")).toHaveValue("Tessa");
      // a new, unsaved edit, then undo of the earlier save
      await field(page, "title").fill("Dr");
      await expect(page.locator("[data-hfy-bar-text]")).toHaveText("1 change — 1 saves now");
      await page.locator("[data-hfy-undo]").click();
      await expect(page.locator("[data-hfy-toast-text]")).toHaveText("undone.");
      await expect(field(page, "nickname")).toHaveValue("Tess");
      await expect(field(page, "title")).toHaveValue("Dr");
      await expect(page.locator("[data-hfy-bar-text]")).toHaveText("1 change — 1 saves now");
      // and what is left to save is only the new edit, against the record as the undo left it
      await page.locator("[data-hfy-review]").click();
      await expect(sheet(page).locator("[data-hfy-save]")).toBeVisible();
      const dry = server.calls[server.calls.length - 1];
      expect(dry.body.ops.map((o) => [o.id, o.base, o.value])).toEqual([["names.title", null, "Dr"]]);
    });

    test("typing while the refetch after a save is still out keeps what was typed", async ({ page }) => {
      const server = await open(page);
      await field(page, "nickname").fill("Tessa");
      await page.locator("[data-hfy-review]").click();
      let release;
      server.hold = new Promise((resolve) => { release = resolve; });
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(page.locator("[data-hfy-toast-text]")).toHaveText("saved.");
      await field(page, "title").fill("Dr");
      release();
      await expect(field(page, "nickname")).toHaveValue("Tessa");
      await expect(field(page, "title")).toHaveValue("Dr");
      await expect(page.locator("[data-hfy-bar-text]")).toHaveText("1 change — 1 saves now");
    });

    test("an undo that fails for a moment can be tried again, under the same key", async ({ page }) => {
      let failures = 1;
      const server = await open(page, { script: (call) => (call.body.ops.some((o) => o.seq) && failures-- > 0 ? { status: 503, json: { error: "unavailable", message: "busy" } } : null) });
      await field(page, "nickname").fill("Tessa");
      await page.locator("[data-hfy-review]").click();
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(page.locator("[data-hfy-toast-text]")).toHaveText("saved.");
      await page.locator("[data-hfy-undo]").click();
      await expect(page.locator("[data-hfy-toast-text]")).toHaveText("saved. the site is busy. try again in a moment.");
      await expect(page.locator("[data-hfy-undo]")).toBeEnabled();
      await page.locator("[data-hfy-undo]").click();
      await expect(page.locator("[data-hfy-toast-text]")).toHaveText("undone.");
      const undos = server.calls.filter((c) => c.body.ops.some((o) => o.seq));
      expect(undos).toHaveLength(2);
      expect(undos[1].key).toBe(undos[0].key);
      await expect(field(page, "nickname")).toHaveValue("Tess");
    });

    test("an undo the server refuses ends the offer", async ({ page }) => {
      await open(page, { script: (call) => (call.body.ops.some((o) => o.seq) ? { status: 403, json: { error: "not_allowed", message: "no" } } : null) });
      await field(page, "nickname").fill("Tessa");
      await page.locator("[data-hfy-review]").click();
      await sheet(page).locator("[data-hfy-save]").click();
      await page.locator("[data-hfy-undo]").click();
      await expect(page.locator("[data-hfy-toast-text]")).toHaveText("we couldn't undo that. please look at the page and change it by hand.");
      await expect(page.locator("[data-hfy-undo]")).toHaveCount(0);
    });

    test("a second, later 409 on the save gets its own replay", async ({ page }) => {
      let conflicts = 0;
      const server = await open(page, {
        script: (call, n, srv) => {
          if (call.body.dry_run) return conflicts === 0 && n === 1 ? (conflicts = 1, srv.version = 5, { status: 409, json: { error: "version_conflict", message: "changed" } }) : null;
          if (conflicts === 1) { conflicts = 2; srv.version = 6; return { status: 409, json: { error: "version_conflict", message: "changed" } }; }
          return null;
        }
      });
      await field(page, "nickname").fill("Tessa");
      await page.locator("[data-hfy-review]").click();
      // the dry run hit the first 409 and replayed; now the save hits another
      await expect(sheet(page).locator("[data-hfy-notice]")).toBeVisible();
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(sheet(page).locator("[data-hfy-notice]")).toHaveText("this page just changed — please check your edits.");
      await expect(sheet(page).locator("[data-hfy-problem]")).toHaveCount(0);
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(page.locator("[data-hfy-toast-text]")).toHaveText("saved.");
      expect(server.calls[server.calls.length - 1].body.base_versions).toEqual({ [KEY]: 6 });
    });

    test("two conflicts in a row on the dry run end in an error with a review again button", async ({ page }) => {
      await open(page, { script: (call) => (call.body.dry_run ? { status: 409, json: { error: "version_conflict", message: "changed" } } : null) });
      await field(page, "nickname").fill("Tessa");
      await page.locator("[data-hfy-review]").click();
      await expect(sheet(page).locator("[data-hfy-problem]")).toContainText("this page just changed");
      await expect(sheet(page).locator("[data-hfy-retry]")).toHaveText("review again");
      await expect(sheet(page).locator("[data-hfy-save]")).toHaveCount(0);
    });

    test("a step-up sign-in asks the sign-in page for a fresh one", async ({ page }) => {
      await open(page, { script: (call) => (call.body.dry_run ? null : { status: 403, json: { error: "step_up_required", message: "again" } }) });
      await field(page, "nickname").fill("Tessa");
      await page.locator("[data-hfy-review]").click();
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(sheet(page).locator("[data-hfy-problem]")).toContainText("sign in again to confirm this change");
      await expect(sheet(page).locator(".hfy-sheet__signin")).toHaveAttribute("href", /^\/auth\/login\?prompt=login&returnTo=/);
    });

    test("a save of suggestions only says it was sent", async ({ page }) => {
      await open(page);
      await field(page, "given names").fill("Tester");
      await page.locator("[data-hfy-review]").click();
      await expect(sheet(page).locator('[data-hfy-group="hfy-sheet-direct"]')).toHaveCount(0);
      await expect(sheet(page).locator("[data-hfy-save]")).toHaveText("send for review");
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(page.locator("[data-hfy-toast-text]")).toHaveText("sent. you can change or withdraw it until an admin looks.");
      await expect(page.locator("[data-hfy-undo]")).toHaveCount(0);
    });

    test("an admin has no review group", async ({ page }) => {
      await open(page, { admin: true, relation: "other" });
      await field(page, "given names").fill("Tester");
      await page.locator("[data-hfy-review]").click();
      await expect(sheet(page).locator('[data-hfy-group="hfy-sheet-direct"] li')).toHaveCount(1);
      await expect(sheet(page).locator('[data-hfy-group="hfy-sheet-review"]')).toHaveCount(0);
      await expect(sheet(page).locator("[data-hfy-save]")).toHaveText("save");
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(page.locator("[data-hfy-toast-text]")).toHaveText("saved.");
    });

    test("409 on the dry run: the bundle is refetched, the member's edits replay over it, the notice says so", async ({ page }) => {
      const server = await open(page, {
        script: (call, n, srv) => {
          if (n !== 1) return null;
          // somebody else changed the title in the meantime
          srv.obj = objWith({ title: "Rev" });
          srv.version = 7;
          return { status: 409, json: { error: "version_conflict", message: "the page changed", details: { current: { [KEY]: 7 } } } };
        }
      });
      await field(page, "nickname").fill("Tessa");
      await page.locator("[data-hfy-review]").click();
      await expect(sheet(page).locator("[data-hfy-notice]")).toHaveText("this page just changed — please check your edits.");
      await expect(sheet(page).locator('[data-hfy-group="hfy-sheet-direct"] li')).toHaveText(["change the nickname from Tess to Tessa"]);
      expect(server.bundleGets).toBe(2);
      expect(server.calls).toHaveLength(2);
      expect(server.calls[1].body).toEqual({
        target: KEY, base_versions: { [KEY]: 7 }, dry_run: true,
        ops: [{ id: "names.nick", op: "set", obj: KEY, path: "/primary_name/nick", base: "Tess", value: "Tessa" }]
      });
      // the member's value is still in the form, over the fresh record (the other person's title is shown too)
      await sheet(page).locator("[data-hfy-back]").click();
      await expect(field(page, "nickname")).toHaveValue("Tessa");
      await expect(field(page, "title")).toHaveValue("Rev");
      await expect(page.locator("[data-hfy-bar-text]")).toHaveText("1 change — 1 saves now");
    });

    test("409 on the save: replayed once with the new versions and a fresh key, then it saves", async ({ page }) => {
      const server = await open(page, {
        script: (call, n, srv) => {
          if (call.body.dry_run || srv.version !== 4) return null;
          srv.obj = objWith({ suffix: "Jr" });
          srv.version = 6;
          return { status: 409, json: { error: "version_conflict", message: "the page changed", details: { current: { [KEY]: 6 } } } };
        }
      });
      await field(page, "nickname").fill("Tessa");
      await page.locator("[data-hfy-review]").click();
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(sheet(page).locator("[data-hfy-notice]")).toHaveText("this page just changed — please check your edits.");
      await expect(sheet(page).locator("[data-hfy-save]")).toBeVisible();
      const first = server.calls[1];
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(page.locator("[data-hfy-toast-text]")).toHaveText("saved.");
      const last = server.calls[server.calls.length - 1];
      expect(last.body.base_versions).toEqual({ [KEY]: 6 });
      expect(last.key).not.toBe(first.key);
      await expect(field(page, "suffix")).toHaveValue("Jr");
      await expect(field(page, "nickname")).toHaveValue("Tessa");
    });

    test("an error from the server is said in plain words in the sheet, naming the field", async ({ page }) => {
      await open(page, {
        script: (call) => (call.body.dry_run ? null : { status: 422, json: { error: "contact_info", message: "contact details", errors: [{ pointer: "/ops/0/value", kind: "phone", span: [0, 4] }] } })
      });
      await field(page, "nickname").fill("Tessa");
      await page.locator("[data-hfy-review]").click();
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(sheet(page).locator("[data-hfy-problem]")).toContainText("this looks like a phone number, a street address or an email. please remove it.");
      await expect(sheet(page).locator("[data-hfy-problem]")).toContainText("check: nickname");
      expect(await axeViolations(page)).toEqual([]);
      await sheet(page).locator("[data-hfy-back]").click();
      await expect(field(page, "nickname")).toHaveValue("Tessa");
    });
  });
}

test("the undo goes away after 10 minutes", async ({ page }) => {
  await page.clock.install();
  await open(page);
  await field(page, "nickname").fill("Tessa");
  await page.locator("[data-hfy-review]").click();
  await sheet(page).locator("[data-hfy-save]").click();
  await expect(page.locator("[data-hfy-undo]")).toBeVisible();
  await page.clock.fastForward("09:30");
  await expect(page.locator("[data-hfy-undo]")).toBeVisible();
  await page.clock.fastForward("01:00");
  await expect(page.locator("[data-hfy-undo]")).toHaveCount(0);
  await expect(page.locator("[data-hfy-toast-text]")).toHaveText("saved.");
});
