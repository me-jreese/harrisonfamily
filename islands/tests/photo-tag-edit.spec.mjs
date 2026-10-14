// HFY-TSK-260 (tag-editor-ui, flag photoTagEdit): the photo tag editor in the person page's lightbox at 375 and 1280: draw, move, resize and remove a
// tag, the person picker, the keyboard and touch alternatives (nudge buttons, 44px handles), the confirmation sheet's split, stale tags, axe.
// Synthetic people only. /auth, /api, the flags file, the person JSON and the media are stubbed by route interception; /api/changes is a small fake
// store that applies the ops with the API's own op engine (api/src/records/ops.js), so what the page sends is what is judged: a tag on the viewer's
// own record saves now, on someone else's it is a suggestion, an admin's saves now, and a stale key is a conflict that changes nothing.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/photo-tag-edit.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { applyOps } from "../../api/src/records/ops.js";
import { axeViolations } from "./axe.mjs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
const URL_PATH = "/person/?id=I9001";
const ME = "I9002"; // the signed-in member (the page's spouse)
const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 900 }]];
const SIZES = { MTAG1: [800, 600], MTAG2: [600, 900] };
const svg = (name) => { const [w, h] = SIZES[name] || [800, 600]; return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="gray"/></svg>`; };
const ref = (handle, rect, extra = {}) => ({ _class: "MediaRef", private: false, citation_list: [], note_list: [], attribute_list: [], ref: handle, rect, ...extra });

const GALLERY = {
  ...PERSON,
  mediaGallery: [
    { handle: "MTAG1", mime: "image/jpeg", title: "Landscape group", grampsId: "O1", tags: [
      { grampsId: "I9002", name: "Sam Example", rect: [10, 20, 30, 50], isPrimary: false, attributes: [], notes: [], citations: [], source: "gramps" },
      { grampsId: "I9012", name: "Father Example", rect: [60, 15, 90, 45], isPrimary: false, attributes: [], notes: [], citations: [], source: "gramps" }
    ] },
    { handle: "MTAG2", mime: "image/jpeg", title: "Portrait, nobody tagged yet", grampsId: "O2" }
  ]
};
const PEOPLE = [{ grampsId: "I9002", displayName: "Sam Example", lifespanSummary: "1970-", isLiving: true }, { grampsId: "I9003", displayName: "Robin Sample", lifespanSummary: "1960-", isLiving: true }, { grampsId: "I9012", displayName: "Father Example", lifespanSummary: "1930-2001", isLiving: false }];

/**
 * The flags, session, /api/me, the edit bundles and /api/changes in memory. `store` maps a Gramps id to { handle, version, obj }; `calls` collects every
 * /api/changes request; `hooks.beforeSave(entry)` may change the store just before a real save is judged (another session's edit).
 */
async function stub(page, { flag = true, admin = false, editing = true } = {}) {
  const store = {
    I9002: { handle: "hp2", version: 3, obj: { _class: "Person", handle: "hp2", gramps_id: "I9002", media_list: [ref("MTAG1", [10, 20, 30, 50])] } },
    I9012: { handle: "hp12", version: 5, obj: { _class: "Person", handle: "hp12", gramps_id: "I9012", media_list: [ref("MTAG1", [60, 15, 90, 45])] } },
    I9003: { handle: "hp3", version: 1, obj: { _class: "Person", handle: "hp3", gramps_id: "I9003", media_list: [] } }
  };
  const state = { store, calls: [], bundles: [], hooks: {}, hits: { island: 0 } };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: true, photoTagEdit: flag, recordEdit: false } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: ME, grampsId: ME, label: "Sam Example" } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { id: ME, label: "Sam Example", admin, can: {}, ownRecord: { cls: "Person", handle: "hp2", gramps_id: ME }, editing } }));
  await page.route("**/api/edit/Person/*", (r) => {
    const gid = decodeURIComponent(new URL(r.request().url()).pathname.split("/").pop());
    const e = store[gid];
    state.bundles.push(gid);
    if (!e) return r.fulfill({ status: 404, json: { error: "not_found" } });
    return r.fulfill({ json: { key: `Person:${e.handle}`, version: e.version, etag: `Person:${e.handle}@${e.version}`, obj: e.obj, related: {}, relation: gid === ME ? "own" : "other", viewer: { admin }, policy: { rows: [] }, pending: [], customTypes: {}, schemaHash: "0".repeat(64) } });
  });
  await page.route("**/api/changes", async (route) => {
    const req = route.request();
    const body = req.postDataJSON();
    const call = { body, key: req.headers()["idempotency-key"] };
    state.calls.push(call);
    const target = body.target;
    const entry = Object.values(store).find((e) => `Person:${e.handle}` === target);
    if (!entry) return route.fulfill({ status: 404, json: { error: "not_found" } });
    if (!body.dry_run && state.hooks.beforeSave) { state.hooks.beforeSave(entry); state.hooks.beforeSave = null; }
    if (body.dry_run && state.hooks.delayDry) await new Promise((res) => setTimeout(res, state.hooks.delayDry));
    if (body.base_versions[target] !== entry.version) return route.fulfill({ status: 409, json: { error: "version_conflict", message: "the page changed since you opened it", details: { current: { [target]: entry.version } } } });
    const applied = applyOps({ [target]: entry.obj }, body.ops);
    if (!applied.ok) return route.fulfill({ status: 409, json: { error: "version_conflict", message: "the page changed since you opened it", details: { current: { [target]: entry.version }, conflicts: applied.conflicts } } });
    const own = admin || entry.obj.gramps_id === ME;
    const opIds = body.ops.map((o) => o.id);
    const summary = body.ops.map((o) => ({ text: "add a photo", opIds: [o.id] }));
    if (body.dry_run) return route.fulfill({ json: { plan: own ? { direct: [{ opIds, summary }], review: [] } : { direct: [], review: [{ opIds, summary }] }, warnings: [], errors: [] } });
    if (!call.key) return route.fulfill({ status: 400, json: { error: "validation", message: "Idempotency-Key is required" } });
    if (own) {
      entry.obj = applied.objects[target];
      entry.version += 1;
      return route.fulfill({ status: 201, json: { applied: { versions: { [target]: entry.version }, undo: { base_versions: { [target]: entry.version }, ops: applied.inverse } }, proposal: null, summary: summary.map((s) => ({ ...s, route: "direct" })) } });
    }
    return route.fulfill({ status: 201, json: { applied: null, proposal: { id: "P1", state: "pending" }, summary: summary.map((s) => ({ ...s, route: "review" })) } });
  });
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: PEOPLE } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: PEOPLE.map((p) => ({ grampsId: p.grampsId, searchText: p.displayName.toLowerCase() })) } }));
  await page.route("**/person/I9001.json", (r) => r.fulfill({ json: GALLERY }));
  await page.route("**/media/tree_I9001.svg", (r) => r.fulfill({ contentType: "image/svg+xml", body: readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8") }));
  await page.route(/\/media\/MTAG\d\.jpg/, (r) => r.fulfill({ contentType: "image/svg+xml", body: svg(r.request().url().match(/MTAG\d/)[0]) }));
  await page.route(/\/js\/islands\/photo-tag-edit\.js/, (r) => { state.hits.island += 1; return r.continue(); });
  return state;
}

async function openLightbox(page, opts, index = 0) {
  const state = await stub(page, opts);
  await page.goto(URL_PATH, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-hero h1")).toHaveText("Test Person (synthetic)");
  const fig = page.locator("#person-media-grid .gallery-item").nth(index);
  await fig.scrollIntoViewIfNeeded();
  await fig.locator("button.media-lightbox-trigger").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#mediaLightboxImage")).toBeVisible();
  return state;
}

const toggle = (page) => page.locator("#mediaLightbox button.photo-tag-edit__toggle");
const layer = (page) => page.locator("#mediaLightbox [data-hfy-tag-layer]");
const panel = (page) => page.locator("#mediaLightbox [data-hfy-tag-panel]");
const sheet = (page) => page.locator("#mediaLightbox dialog.hfy-sheet");
async function tagging(page, opts, index) {
  const state = await openLightbox(page, opts, index);
  await expect(toggle(page)).toBeVisible();
  await toggle(page).click();
  await expect(layer(page)).toBeVisible();
  return state;
}

/** The picture's box in page coordinates, to turn percent of the photo into mouse positions. */
const pictureBox = (page) => page.evaluate(() => {
  const img = document.getElementById("mediaLightboxImage");
  const r = img.getBoundingClientRect();
  const s = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
  const w = img.naturalWidth * s;
  const h = img.naturalHeight * s;
  return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h };
});
const at = (b, px, py) => [b.x + (px / 100) * b.w, b.y + (py / 100) * b.h];
async function drag(page, from, to) {
  const b = await pictureBox(page);
  const [x1, y1] = at(b, ...from);
  const [x2, y2] = at(b, ...to);
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 });
  await page.mouse.move(x2, y2, { steps: 4 });
  await page.mouse.up();
}
async function pickPerson(page, typed, name) {
  const box = panel(page).getByRole("combobox");
  await box.fill(typed);
  await panel(page).getByRole("option", { name: new RegExp(name) }).click();
}
const lastRealCall = (state) => state.calls.filter((c) => !c.body.dry_run).at(-1);
const near = (rect, want, tol = 2) => rect.every((v, i) => Math.abs(v - want[i]) <= tol);

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("the toggle is 44px and turns the editing layer on over the photo, with the page's tags as boxes", async ({ page }) => {
      await openLightbox(page);
      await expect(toggle(page)).toBeVisible();
      expect((await toggle(page).boundingBox()).height).toBeGreaterThanOrEqual(43.9);
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
      await expect(layer(page)).toHaveCount(0);
      await toggle(page).click();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
      await expect(layer(page)).toBeVisible();
      const regions = layer(page).locator("button.photo-tag-edit__region");
      await expect(regions).toHaveCount(2);
      await expect(regions.nth(0)).toHaveAccessibleName("Sam Example: change this tag");
      // the boxes sit on the photo where the data says (within a pixel)
      const b = await pictureBox(page);
      const r0 = await regions.nth(0).boundingBox();
      const [lx, ly] = at(b, 10, 20);
      expect(Math.abs(r0.x - lx)).toBeLessThan(1.5);
      expect(Math.abs(r0.y - ly)).toBeLessThan(1.5);
      // the view layer's links give way while editing
      await expect(page.locator("#mediaLightbox a.photo-tags__region").first()).toBeHidden();
      // the layer takes touch for itself (no scroll or swipe while drawing)
      expect(await layer(page).evaluate((el) => getComputedStyle(el).touchAction)).toBe("none");
      await toggle(page).click();
      await expect(layer(page)).toHaveCount(0);
      await expect(page.locator("#mediaLightbox a.photo-tags__region").first()).toBeVisible();
    });

    test("draw a box, pick yourself: the sheet says it saves now, and the save adds one clean MediaRef with a whole-percent rect", async ({ page }) => {
      const state = await tagging(page, {}, 0);
      await drag(page, [40.3, 60.2], [70.6, 90.1]);
      await expect(panel(page).getByRole("combobox")).toBeFocused();
      await expect(panel(page).locator("[data-hfy-tag-save]")).toBeDisabled();
      await pickPerson(page, "sam", "Sam Example");
      await expect(panel(page).locator("[data-hfy-tag-who]")).toContainText("Sam Example");
      await expect(panel(page).locator("[data-hfy-tag-who] a")).toHaveAttribute("href", "/person/?id=I9002");
      await expect(panel(page).locator("[data-hfy-tag-route]")).toHaveAttribute("data-hfy-tag-route", "direct");
      await panel(page).locator("[data-hfy-tag-save]").click();
      await expect(sheet(page)).toBeVisible();
      await expect(sheet(page).locator("[data-hfy-group='hfy-sheet-direct']")).toContainText("tag Sam Example in this photo");
      await expect(sheet(page).locator("[data-hfy-group='hfy-sheet-review']")).toHaveCount(0);
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(panel(page).locator("[data-hfy-tag-toast]")).toHaveText("saved. the tag is on the photo.");
      const call = lastRealCall(state);
      expect(call.key).toBeTruthy();
      expect(call.body.target).toBe("Person:hp2");
      expect(call.body.base_versions).toEqual({ "Person:hp2": 3 });
      expect(call.body.ops).toHaveLength(1);
      const op = call.body.ops[0];
      expect([op.op, op.path]).toEqual(["add", "/media_list"]);
      expect(op.value).toMatchObject({ _class: "MediaRef", ref: "MTAG1", private: false, citation_list: [], note_list: [], attribute_list: [] });
      expect(op.value.rect.every(Number.isInteger)).toBe(true);
      expect(near(op.value.rect, [40, 60, 71, 91], 1), JSON.stringify(op.value.rect)).toBe(true);
      expect(op.value.rect[2] - op.value.rect[0]).toBeGreaterThanOrEqual(1);
      expect(state.store.I9002.obj.media_list).toHaveLength(2);
      // the page's own view of the photo has the new tag without a reload
      await toggle(page).click();
      await expect(page.locator("#mediaLightbox ul.photo-tags__names .photo-tags__name")).toHaveText(["Sam Example", "Father Example", "Sam Example"]);
      await expect(page.locator("#mediaLightbox a.photo-tags__region")).toHaveCount(3);
    });

    test("tag someone else's page: the sheet says it goes to review, and nothing on the photo changes", async ({ page }) => {
      const state = await tagging(page, {}, 0);
      await drag(page, [10, 60], [30, 80]);
      await pickPerson(page, "robin", "Robin Sample");
      await expect(panel(page).locator("[data-hfy-tag-route]")).toHaveAttribute("data-hfy-tag-route", "review");
      await panel(page).locator("[data-hfy-tag-save]").click();
      await expect(sheet(page).locator("[data-hfy-group='hfy-sheet-review']")).toContainText("tag Robin Sample in this photo");
      await expect(sheet(page).locator("[data-hfy-group='hfy-sheet-direct']")).toHaveCount(0);
      await expect(sheet(page).locator("[data-hfy-who]")).toContainText("looks these over");
      await sheet(page).locator("[data-hfy-note]").fill("she is on the left");
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(panel(page).locator("[data-hfy-tag-toast]")).toContainText("sent for review");
      expect(lastRealCall(state).body.note).toBe("she is on the left");
      expect(state.store.I9003.obj.media_list).toEqual([]);
      await toggle(page).click();
      await expect(page.locator("#mediaLightbox ul.photo-tags__names .photo-tags__name")).toHaveText(["Sam Example", "Father Example"]);
    });

    test("keyboard only: add a tag, nudge each edge and the whole box with the buttons, pick a person, save", async ({ page }) => {
      const state = await tagging(page, {}, 1);
      await panel(page).locator("[data-hfy-tag-add]").focus();
      await page.keyboard.press("Enter");
      await expect(panel(page).getByRole("combobox")).toBeFocused();
      await page.keyboard.type("sam");
      await expect(panel(page).getByRole("option", { name: /Sam Example/ })).toBeVisible();
      await page.keyboard.press("Enter"); // the first match is already the active one
      await expect(panel(page).locator("[data-hfy-tag-who]")).toContainText("Sam Example");
      const nudge = (edge, dir, n = 1) => panel(page).locator(`[data-edge="${edge}"][data-dir="${dir}"]`);
      for (const [edge, dir, times] of [["left", -1, 3], ["right", 1, 1], ["top", -1, 2], ["bottom", -1, 5]]) for (let k = 0; k < times; k += 1) await nudge(edge, dir).click();
      // the default box is the middle quarter, [35, 35, 65, 65]
      await panel(page).locator("[data-move='right']").click();
      await panel(page).locator("[data-move='down']").click();
      await panel(page).locator("[data-hfy-tag-save]").click();
      await expect(sheet(page)).toBeVisible();
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(panel(page).locator("[data-hfy-tag-toast]")).toBeVisible();
      const op = lastRealCall(state).body.ops[0];
      expect(op.value.ref).toBe("MTAG2");
      expect(op.value.rect).toEqual([33, 34, 67, 61]); // [35,35,65,65]: left edge 3 out, right edge 1 out, top edge 2 up, bottom edge 5 up, then the whole box 1 right and 1 down
    });

    test("every edge button and move button has a name and is a 44px target", async ({ page }) => {
      await tagging(page, {}, 1);
      await panel(page).locator("[data-hfy-tag-add]").click();
      const buttons = panel(page).locator("[data-hfy-tag-nudge] button");
      await expect(buttons).toHaveCount(12);
      for (const handle of await buttons.elementHandles()) {
        const label = await handle.getAttribute("aria-label");
        expect(label).toMatch(/^move the /);
        const box = await handle.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(43.9);
        expect(box.width).toBeGreaterThanOrEqual(43.9);
      }
      await expect(panel(page).getByRole("button", { name: "move the left edge left" })).toBeVisible();
      await expect(panel(page).getByRole("button", { name: "move the bottom edge down" })).toBeVisible();
    });

    test("move and resize an existing tag by pointer: a set of rect at the tag's key, with the stored rect as the base", async ({ page }) => {
      const state = await tagging(page, {}, 0);
      const mine = layer(page).locator("button.photo-tag-edit__region").nth(0);
      await mine.click();
      await expect(mine).toHaveAttribute("aria-pressed", "true");
      await expect(panel(page).locator("[data-hfy-tag-who]")).toContainText("Sam Example");
      await expect(panel(page).locator("[data-hfy-tag-save]")).toBeDisabled();
      const handles = layer(page).locator("button.photo-tag-edit__handle");
      await expect(handles).toHaveCount(4);
      for (const h of await handles.elementHandles()) {
        const box = await h.boundingBox();
        expect(box.width).toBeGreaterThanOrEqual(43.9);
        expect(box.height).toBeGreaterThanOrEqual(43.9);
      }
      // drag the south-east corner from (30, 50) to (36, 56), then the whole box 4 right
      const b = await pictureBox(page);
      const se = await layer(page).locator("button.photo-tag-edit__handle[data-corner='se']").boundingBox();
      await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2);
      await page.mouse.down();
      await page.mouse.move(...at(b, 36, 56), { steps: 5 });
      await page.mouse.up();
      await expect(panel(page).locator("[data-hfy-tag-save]")).toBeEnabled();
      await panel(page).locator("[data-hfy-tag-save]").click();
      await expect(sheet(page).locator("[data-hfy-group='hfy-sheet-direct']")).toContainText("change where Sam Example is tagged in this photo");
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(panel(page).locator("[data-hfy-tag-toast]")).toBeVisible();
      const op = lastRealCall(state).body.ops[0];
      expect(op.op).toBe("set");
      expect(op.path).toMatch(/^\/media_list\/@ref=MTAG1#0:[0-9a-f]{12}\/rect$/);
      expect(op.base).toEqual([10, 20, 30, 50]);
      expect(near(op.value, [10, 20, 36, 56], 1)).toBe(true);
      expect(op.value.every(Number.isInteger)).toBe(true);
      expect(state.store.I9002.obj.media_list[0].rect).toEqual(op.value);
      // the page's view layer follows
      await toggle(page).click();
      const r = await page.locator("#mediaLightbox a.photo-tags__region").evaluateAll((els) => els.length);
      expect(r).toBe(2);
    });

    test("move by dragging the box body and with the arrow keys on it; Shift makes a big step", async ({ page }) => {
      const state = await tagging(page, {}, 0);
      const mine = layer(page).locator("button.photo-tag-edit__region").nth(0);
      await mine.click();
      await mine.focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Shift+ArrowDown");
      await expect(page.locator("#mediaLightboxCounter")).toHaveText("1 of 2"); // the arrows did not step to the next photo
      await panel(page).locator("[data-hfy-tag-save]").click();
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(panel(page).locator("[data-hfy-tag-toast]")).toBeVisible();
      expect(lastRealCall(state).body.ops[0].value).toEqual([11, 25, 31, 55]);
    });

    test("remove your own tag; a tag of someone else has no remove button", async ({ page }) => {
      const state = await tagging(page, {}, 0);
      const regions = layer(page).locator("button.photo-tag-edit__region");
      await regions.nth(1).click();
      await expect(panel(page).locator("[data-hfy-tag-who]")).toContainText("Father Example");
      await expect(panel(page).locator("[data-hfy-tag-remove]")).toHaveCount(0);
      await regions.nth(0).click();
      await expect(panel(page).locator("[data-hfy-tag-remove]")).toBeVisible();
      await panel(page).locator("[data-hfy-tag-remove]").click();
      await expect(sheet(page).locator("[data-hfy-group='hfy-sheet-direct']")).toContainText("remove Sam Example");
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(panel(page).locator("[data-hfy-tag-toast]")).toHaveText("the tag is removed.");
      const op = lastRealCall(state).body.ops[0];
      expect(op.op).toBe("remove");
      expect(op.path).toMatch(/^\/media_list\/@ref=MTAG1#0:[0-9a-f]{12}$/);
      expect(op.base).toMatchObject({ ref: "MTAG1", rect: [10, 20, 30, 50] });
      expect(state.store.I9002.obj.media_list).toEqual([]);
      await expect(layer(page).locator("button.photo-tag-edit__region")).toHaveCount(1);
    });

    test("an admin can remove anyone's tag and a tag on someone else's page saves now", async ({ page }) => {
      const state = await tagging(page, { admin: true }, 0);
      await layer(page).locator("button.photo-tag-edit__region").nth(1).click();
      await expect(panel(page).locator("[data-hfy-tag-remove]")).toBeVisible();
      await panel(page).locator("[data-hfy-tag-cancel]").click();
      await drag(page, [10, 60], [30, 80]);
      await pickPerson(page, "robin", "Robin Sample");
      await expect(panel(page).locator("[data-hfy-tag-route]")).toHaveAttribute("data-hfy-tag-route", "direct");
      await panel(page).locator("[data-hfy-tag-save]").click();
      await expect(sheet(page).locator("[data-hfy-group='hfy-sheet-direct']")).toContainText("tag Robin Sample");
      await expect(sheet(page).locator("[data-hfy-group='hfy-sheet-review']")).toHaveCount(0);
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(panel(page).locator("[data-hfy-tag-toast]")).toHaveText("saved. the tag is on the photo.");
      expect(state.store.I9003.obj.media_list).toHaveLength(1);
    });

    test("a tag that changed since the page was built is never moved: nothing is sent and the sheet says so", async ({ page }) => {
      const state = await tagging(page, {}, 0);
      state.store.I9002.obj = { ...state.store.I9002.obj, media_list: [ref("MTAG1", [11, 20, 30, 50])] }; // somebody moved it since the page's data was built
      state.store.I9002.version += 1;
      await layer(page).locator("button.photo-tag-edit__region").nth(0).click();
      await panel(page).locator("[data-hfy-tag-nudge] [data-move='right']").click();
      await panel(page).locator("[data-hfy-tag-save]").click();
      await expect(sheet(page).locator("[data-hfy-problem]")).toContainText("this tag changed while you were looking");
      expect(state.calls).toEqual([]);
      await sheet(page).locator("[data-hfy-back]").click();
      expect(state.store.I9002.obj.media_list[0].rect).toEqual([11, 20, 30, 50]);
    });

    test("a conflict at save time reads the tag again and plans once more; if the tag is gone it says so and changes nothing", async ({ page }) => {
      const state = await tagging(page, {}, 0);
      state.hooks.beforeSave = (entry) => { entry.obj = { ...entry.obj, media_list: [ref("MTAG1", [12, 22, 32, 52])] }; entry.version += 1; };
      await layer(page).locator("button.photo-tag-edit__region").nth(0).click();
      await panel(page).locator("[data-hfy-tag-nudge] [data-move='right']").click();
      await panel(page).locator("[data-hfy-tag-save]").click();
      await expect(sheet(page).locator("[data-hfy-save]")).toBeVisible();
      await sheet(page).locator("[data-hfy-save]").click();
      await expect(sheet(page).locator("[data-hfy-problem]")).toContainText("this tag changed while you were looking");
      expect(state.store.I9002.obj.media_list[0].rect).toEqual([12, 22, 32, 52]);
      expect(state.store.I9002.version).toBe(4);
    });

    test("Esc leaves the box being changed first, and only then the lightbox; the sheet closes on Esc without closing the lightbox", async ({ page }) => {
      await tagging(page, {}, 0);
      await layer(page).locator("button.photo-tag-edit__region").nth(0).click();
      await panel(page).locator("[data-hfy-tag-nudge] [data-move='right']").click();
      await layer(page).locator("button.photo-tag-edit__region").nth(0).focus();
      await page.keyboard.press("Escape");
      await expect(panel(page).locator("[data-hfy-tag-save]")).toHaveCount(0);
      await expect(page.locator("#mediaLightbox")).toBeVisible();
      await layer(page).locator("button.photo-tag-edit__region").nth(0).click();
      await panel(page).locator("[data-hfy-tag-nudge] [data-move='right']").click();
      await panel(page).locator("[data-hfy-tag-save]").click();
      await expect(sheet(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(sheet(page)).toBeHidden();
      await expect(page.locator("#mediaLightbox")).toBeVisible();
      await expect(layer(page)).toBeVisible();
    });

    test("closing the sheet while it is still checking leaves it closed when the answer arrives", async ({ page }) => {
      const state = await tagging(page, {}, 0);
      state.hooks.delayDry = 700;
      await layer(page).locator("button.photo-tag-edit__region").nth(0).click();
      await panel(page).locator("[data-hfy-tag-nudge] [data-move='right']").click();
      await panel(page).locator("[data-hfy-tag-save]").click();
      await expect(sheet(page)).toBeVisible();
      await expect(sheet(page)).toHaveAttribute("data-hfy-sheet", "planning");
      await page.keyboard.press("Escape");
      await expect(sheet(page)).toBeHidden();
      await page.waitForTimeout(1000);
      await expect(sheet(page)).toBeHidden();
      expect(state.calls.filter((c) => !c.body.dry_run)).toEqual([]);
    });

    test("axe is clean while editing: the layer with a box selected, the panel, and the confirmation sheet", async ({ page }) => {
      await tagging(page, {}, 0);
      await layer(page).locator("button.photo-tag-edit__region").nth(0).click();
      await panel(page).locator("[data-hfy-tag-nudge] [data-move='right']").click();
      expect(await axeViolations(page, { include: "#mediaLightbox" })).toEqual([]);
      const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(overflow.sw).toBeLessThanOrEqual(overflow.cw);
      await panel(page).locator("[data-hfy-tag-save]").click();
      await expect(sheet(page).locator("[data-hfy-save]")).toBeVisible();
      expect(await axeViolations(page, { include: "#mediaLightbox" })).toEqual([]);
    });
  });
}

test("with photoTagEdit off nothing is requested and the lightbox has no tagging toggle", async ({ page }) => {
  const state = await openLightbox(page, { flag: false });
  await page.waitForTimeout(400);
  await expect(toggle(page)).toHaveCount(0);
  expect(state.hits.island).toBe(0);
  await expect(page.locator("#mediaLightbox a.photo-tags__region").first()).toBeVisible();
});

test("when /api/me says editing is off the toggle stays away", async ({ page }) => {
  await openLightbox(page, { editing: false });
  await page.waitForTimeout(600);
  await expect(toggle(page)).toBeHidden();
});

test("the next photo: the editor follows the lightbox, the mode stays on, and an untagged photo can get its first tag", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await tagging(page, {}, 0);
  await expect(layer(page).locator("button.photo-tag-edit__region")).toHaveCount(2);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#mediaLightboxCounter")).toHaveText("2 of 2");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(layer(page)).toBeVisible();
  await expect(layer(page).locator("button.photo-tag-edit__region")).toHaveCount(0);
  await expect(panel(page).locator("[data-hfy-tag-add]")).toBeVisible();
});

test("a name with markup is text, and the picker never turns typed text into a person", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const state = await tagging(page, {}, 1);
  await panel(page).locator("[data-hfy-tag-add]").click();
  await panel(page).getByRole("combobox").fill("<img src=x onerror=window.__pwned=1>");
  await page.waitForTimeout(300);
  await expect(panel(page).getByRole("option")).toHaveCount(0);
  await expect(panel(page).locator("[data-hfy-tag-save]")).toBeDisabled();
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(state.calls).toEqual([]);
});
