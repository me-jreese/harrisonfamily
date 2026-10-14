// HFY-TSK-212 (flag recordEdit): the edit entry on the person hero (island edit-entry) and the /edit/ shell (island editor), at 375 and 1280.
// Synthetic people only; /auth, /api, the flags file and the person JSON are stubbed. The policy table in the stubbed edit bundle is the real
// one (Person rows, fixtures/edit-policy-person.json), the schema the generated Person schema, so the badges are the ones a viewer would see.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/editor-shell.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";
import { EDIT_SCHEMAS } from "../src/lib/edit-schemas.js";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]];
// The Person rows of DEFAULT_FIELD_POLICY.document() (api/src/records/field-policy.js), as the edit bundle serves them.
const POLICY = JSON.parse(readFileSync(new URL("./fixtures/edit-policy-person.json", import.meta.url), "utf8"));
const OBJ = {
  _class: "Person", handle: "hsyn0001", gramps_id: "I9001",
  primary_name: { _class: "Name", first_name: "Test", nick: "Tess", surname_list: [{ _class: "Surname", surname: "Person", primary: true }] }
};

const bundle = ({ relation = "other", admin = false, pending = [] } = {}) => ({
  key: "Person:hsyn0001", version: 4, etag: "Person:hsyn0001@4", obj: OBJ, related: {}, relation, viewer: { admin }, policy: POLICY, pending, customTypes: {}, schemaHash: "0".repeat(64)
});

/** The flags, session, /api/me and /api/edit routes in memory. `me` is the /api/me body; `status` the edit bundle's answer. */
async function stub(page, { flag = true, session = "I9001", me = {}, relation = "own", admin = false, status = 200, pending = [] } = {}) {
  const state = { islandRequests: [], bundleGets: 0 };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: false, profileLinks: false, recordSubsV1: false, recordEdit: flag } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: session ? { authenticated: true, sub: session, grampsId: session, label: "Sam Example" } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route("**/person/I9001.json", (r) => r.fulfill({ json: PERSON }));
  await page.route("**/media/tree_I9001.svg", (r) => r.fulfill({ contentType: "image/svg+xml", body: readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8") }));
  await page.route(/\/media\/MPHOTO\d\.jpg/, (r) => r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="gray"/></svg>' }));
  await page.route(/\/js\/islands\/(edit-entry|editor)\./, (r) => { state.islandRequests.push(r.request().url()); return r.continue(); });
  await page.route("**/api/me", (r) => r.fulfill({
    status: session ? 200 : 401,
    json: session ? { id: session, label: "Sam Example", admin, can: {}, ownRecord: { cls: "Person", handle: "hsyn0001", gramps_id: session }, editing: true, ...me } : { error: "unauthenticated" }
  }));
  await page.route("**/api/edit/schema/Person", (r) => r.fulfill({ json: { class: "Person", schema: EDIT_SCHEMAS.Person, sha256: "0".repeat(64), schemaHash: "0".repeat(64) } }));
  await page.route("**/api/edit/Person/*", (r) => {
    state.bundleGets += 1;
    return status === 200 ? r.fulfill({ json: bundle({ relation, admin, pending }) }) : r.fulfill({ status, json: { error: "not_found", message: "no such record" } });
  });
  return state;
}

const openPerson = async (page, opts) => {
  const state = await stub(page, opts);
  await page.goto("/person/?id=I9001", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-hero h1")).toHaveText("Test Person (synthetic)");
  return state;
};
const openEditor = async (page, opts, query = "?cls=person&id=I9001") => {
  const state = await stub(page, opts);
  await page.goto(`/edit/${query}`, { waitUntil: "domcontentloaded" });
  return state;
};
const entry = (page) => page.locator('#person-hero [data-slot="hero-actions"] [data-slot="edit"] a.hfy-edit-entry');
const field = (page, label) => page.getByLabel(label, { exact: true });
const badgeOf = (page, label) => page.locator(".io-label-row", { has: page.getByText(label, { exact: true }) }).locator("[data-hfy-mode]");

test.describe("flag off", () => {
  test("no editor bundle is requested on /person/ or /edit/, and /edit/ keeps its note", async ({ page }) => {
    const state = await openPerson(page, { flag: false });
    await page.waitForTimeout(400);
    await expect(page.locator('#person-hero [data-slot="edit"]')).toBeEmpty();
    await page.goto("/edit/?cls=person&id=I9001", { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-editor-off]")).toHaveText("editing isn't available yet.");
    await page.waitForTimeout(400);
    expect(state.islandRequests).toEqual([]);
    expect(state.bundleGets).toBe(0);
  });
});

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("hero action slot: edit my info on the own page, suggest a change on another page, edit for an admin, nothing when editing is off", async ({ page }) => {
      await openPerson(page, { session: "I9001" });
      await expect(entry(page)).toHaveText("edit my info");
      await expect(entry(page)).toHaveAttribute("href", "/edit/?cls=person&id=I9001");
      await expect(entry(page)).toHaveAttribute("data-hfy-edit-entry", "own");
      const box = await entry(page).boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(await axeViolations(page, { include: "#person-hero" })).toEqual([]);
    });

    test("another member sees suggest a change, an admin sees edit", async ({ page }) => {
      await openPerson(page, { session: "I9002", me: { ownRecord: { cls: "Person", handle: "hsyn0002", gramps_id: "I9002" } } });
      await expect(entry(page)).toHaveText("suggest a change");
    });

    test("an admin sees edit", async ({ page }) => {
      await openPerson(page, { session: "I9003", admin: true, me: { ownRecord: null } });
      await expect(entry(page)).toHaveText("edit");
    });

    test("no entry when /api/me says editing is off", async ({ page }) => {
      await openPerson(page, { me: { editing: false } });
      await page.waitForTimeout(400);
      await expect(page.locator('#person-hero [data-slot="edit"]')).toBeEmpty();
    });

    test("editor: own page, every field has an icon-and-words mode badge from the policy table", async ({ page }) => {
      await openEditor(page, { relation: "own" });
      await expect(page.locator("[data-hfy-editor-ready]")).toBeVisible();
      await expect(page.locator("[data-editor-off]")).toHaveCount(0);
      await expect(page.locator("[data-hfy-intro]")).toContainText("this is your page");
      // the subject is the P2-R46 person-name link
      await expect(page.locator(".hfy-editor__subject a.hfy-person-name")).toHaveAttribute("href", "/person/?id=I9001");
      await expect(field(page, "given names")).toHaveValue("Test");
      await expect(field(page, "nickname")).toHaveValue("Tess");
      await expect(badgeOf(page, "given names")).toHaveText("goes to review");
      await expect(badgeOf(page, "nickname")).toHaveText("saves now");
      await expect(badgeOf(page, "title")).toHaveText("saves now");
      const badges = page.locator("[data-hfy-mode]");
      expect(await badges.count()).toBe(5);
      for (const b of await badges.all()) {
        await expect(b.locator("svg[aria-hidden='true']")).toHaveCount(1);
        expect((await b.innerText()).trim().length).toBeGreaterThan(3);
      }
      // Enter in a field is inert: no navigation, no request, the value stays
      const reqs = [];
      page.on("request", (r) => { if (r.method() !== "GET") reqs.push(r.url()); });
      await field(page, "nickname").press("Enter");
      await page.waitForTimeout(200);
      expect(reqs).toEqual([]);
      await expect(page.locator("[data-hfy-editor-ready]")).toBeVisible();
      await expect(field(page, "nickname")).toHaveValue("Tess");
      // the admin-only section is not offered to a member
      await expect(page.locator('[data-section="more"]')).toHaveCount(0);
      expect(await axeViolations(page)).toEqual([]);
    });

    test("editor: another person's page sends nearly everything to review; an admin saves now and sees more", async ({ page }) => {
      await openEditor(page, { relation: "other", session: "I9002" });
      await expect(page.locator("[data-hfy-intro]")).toContainText("go to the family to look over");
      await expect(badgeOf(page, "nickname")).toHaveText("goes to review");
    });

    test("editor: an admin saves now on every field and gets the more section", async ({ page }) => {
      await openEditor(page, { relation: "other", session: "I9003", admin: true });
      await expect(page.locator("[data-hfy-editor-ready]")).toBeVisible();
      for (const label of ["given names", "nickname", "title"]) await expect(badgeOf(page, label)).toHaveText("saves now");
      await expect(page.locator('[data-section="more"]')).toHaveCount(1);
    });

    test("editor: a pending suggestion on a field says so", async ({ page }) => {
      await openEditor(page, { relation: "own", pending: [{ proposalId: "P1", state: "pending", paths: ["/primary_name/nick"] }] });
      await expect(page.locator("[data-hfy-pending]")).toHaveText("a change is waiting for review");
    });

    test("editor: signed out shows a sign-in link; an unknown record says so", async ({ page }) => {
      await openEditor(page, { session: null });
      await expect(page.locator("[data-hfy-gate] a")).toHaveAttribute("href", /\/auth\/login\?returnTo=%2Fedit%2F/);
      await openEditor(page, { status: 404 });
      await expect(page.getByText("we couldn't find that page to edit.")).toBeVisible();
    });

    test("editor: layout, targets and axe", async ({ page }) => {
      await openEditor(page, { relation: "own" });
      await expect(page.locator("[data-hfy-editor-ready]")).toBeVisible();
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(m.sw).toBeLessThanOrEqual(m.cw);
      const inputs = await page.locator(".hfy-editor input").evaluateAll((els) => els.map((e) => ({ fs: parseFloat(getComputedStyle(e).fontSize), h: e.getBoundingClientRect().height })));
      expect(inputs.length).toBeGreaterThan(0);
      for (const i of inputs) { expect(i.fs).toBeGreaterThanOrEqual(16); expect(i.h).toBeGreaterThanOrEqual(44); }
      const toggles = await page.locator(".hfy-editor__toggle").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
      for (const h of toggles) expect(h).toBeGreaterThanOrEqual(44);
      if (name === "375") {
        // an accordion: the first section is open, the others closed until their header is pressed
        await expect(page.locator("#hfy-sec-names-b")).toBeVisible();
        await expect(page.locator("#hfy-sec-events-b")).toBeHidden();
        await page.locator("#hfy-sec-events-h button").click();
        await expect(page.locator("#hfy-sec-events-b")).toBeVisible();
        await expect(page.locator(".hfy-editor__index")).toBeHidden();
      } else {
        // every section is open and the index is sticky: it stays in view after the page scrolls
        await expect(page.locator("#hfy-sec-events-b")).toBeVisible();
        const index = page.locator(".hfy-editor__index");
        await expect(index).toBeVisible();
        expect(await index.evaluate((e) => getComputedStyle(e).position)).toBe("sticky");
        await page.evaluate(() => { document.body.style.minHeight = "4000px"; window.scrollTo(0, 600); });
        const top = await index.evaluate((e) => e.getBoundingClientRect().top);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(top).toBeLessThan(200);
      }
      expect(await axeViolations(page)).toEqual([]);
    });
  });
}

