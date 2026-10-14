// HFY-TSK-157 (flag recordEdit): the editors of the other record classes at 375 and 1280: Event, Place, Source, Citation, Repository, Media (metadata),
// Note and Family open by /edit/?cls=<class>&id=<gramps id or h:handle>; the drill-down links (event to place, citation to source to repository); a
// member's fields all say "goes to review" while an admin's say "saves now"; tags are picked from the ones that exist; the place type select has no
// street, building or number; the repository editor has no addresses; a styled note keeps the styles outside the edit and warns about one it drops.
// Synthetic records only; /auth, /api and the flags file are stubbed.  HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/editor-records.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";
import { EDIT_SCHEMAS } from "../src/lib/edit-schemas.js";

const POLICY = JSON.parse(readFileSync(new URL("./fixtures/edit-policy-all.json", import.meta.url), "utf8"));
const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]];
const typed = (cls, value, string = "") => ({ _class: cls, value, string });
const date = (d, m, y, extra = {}) => ({ _class: "Date", calendar: 0, modifier: 0, quality: 0, dateval: [d, m, y, false], text: "", sortval: 2400000, newyear: 0, ...extra });

const OBJECTS = {
  Event: { _class: "Event", handle: "hse1", gramps_id: "E9001", type: typed("EventType", 21), date: date(14, 3, 1990), place: "hsl1", description: "At home", citation_list: ["hsc1"], note_list: ["hsn1"], tag_list: ["hst1"] },
  Place: { _class: "Place", handle: "hsl1", gramps_id: "P9001", name: { _class: "PlaceName", value: "Synthville", lang: "" }, place_type: typed("PlaceType", 4), code: "", lat: "", long: "", placeref_list: [{ _class: "PlaceRef", ref: "hsl2", date: date(0, 0, 0) }], note_list: [], tag_list: [] },
  Source: { _class: "Source", handle: "hss1", gramps_id: "S9001", title: "A synthetic ledger", author: "", pubinfo: "", abbrev: "", reporef_list: [{ _class: "RepoRef", ref: "hsr1", call_number: "Box 4" }], note_list: [], tag_list: [] },
  Citation: { _class: "Citation", handle: "hsc1", gramps_id: "C9001", source_handle: "hss1", page: "p. 3", confidence: 2, date: date(0, 0, 1951), note_list: [], tag_list: [] },
  Repository: { _class: "Repository", handle: "hsr1", gramps_id: "R9001", name: "Synthetic Archive", type: typed("RepositoryType", 1), note_list: [], tag_list: [] },
  Media: { _class: "Media", handle: "hsm1", gramps_id: "O9001", desc: "Front porch", path: "synthetic/porch.jpg", mime: "image/jpeg", date: date(0, 0, 0), note_list: [], tag_list: [] },
  Note: { _class: "Note", handle: "hsn1", gramps_id: "N9001", type: typed("NoteType", 1), format: 0, tag_list: [], text: { _class: "StyledText", string: "Hello bold world and more", tags: [{ _class: "StyledTextTag", name: typed("StyledTextTagType", 0), value: null, ranges: [[6, 10]] }, { _class: "StyledTextTag", name: typed("StyledTextTagType", 1), value: null, ranges: [[21, 25]] }] } },
  Family: { _class: "Family", handle: "hsf1", gramps_id: "F9001", type: typed("FamilyRelType", 1), father_handle: "hsp1", mother_handle: "hsp2", child_ref_list: [{ _class: "ChildRef", ref: "hsp3" }], event_ref_list: [{ _class: "EventRef", ref: "hse1", role: typed("EventRoleType", 8) }], note_list: [], tag_list: [] }
};
const RELATED = {
  "Place:hsl1": { version: 1, obj: OBJECTS.Place },
  "Place:hsl2": { version: 1, obj: { _class: "Place", handle: "hsl2", gramps_id: "P9002", name: { _class: "PlaceName", value: "Exampleton", lang: "" }, place_type: typed("PlaceType", 2) } },
  "Citation:hsc1": { version: 4, obj: OBJECTS.Citation }, "Source:hss1": { version: 2, obj: OBJECTS.Source }, "Repository:hsr1": { version: 3, obj: OBJECTS.Repository },
  "Note:hsn1": { version: 2, obj: OBJECTS.Note }, "Event:hse1": { version: 3, obj: OBJECTS.Event },
  "Person:hsp1": { version: 1, stub: { displayName: "Sam Example" } }, "Person:hsp2": { version: 1, stub: { displayName: "Pat Example" } }, "Person:hsp3": { version: 1, stub: { displayName: "Robin Sample" } }
};
const TAGS = [{ handle: "hst1", name: "family" }, { handle: "hst2", name: "needs a check" }];
const ID = { Event: "E9001", Place: "P9001", Source: "S9001", Citation: "C9001", Repository: "R9001", Media: "O9001", Note: "N9001", Family: "F9001" };

async function stub(page, { admin = false } = {}) {
  const state = { calls: [] };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: false, profileLinks: false, recordSubsV1: false, recordEdit: true } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: "I9001", grampsId: "I9001", label: "Sam Example" } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { id: "I9001", label: "Sam Example", admin, can: {}, ownRecord: { cls: "Person", handle: "hsyn0001", gramps_id: "I9001" }, editing: true } }));
  await page.route(/\/api\/edit\/(Event|Place|Source|Citation|Repository|Media|Note|Family)\/[^/]+$/, (r) => {
    const cls = new URL(r.request().url()).pathname.split("/")[3];
    const obj = OBJECTS[cls];
    return r.fulfill({ json: { key: `${cls}:${obj.handle}`, version: 7, etag: `${cls}:${obj.handle}@7`, obj, related: RELATED, relation: "other", viewer: { admin }, policy: POLICY, pending: [], customTypes: {}, tags: TAGS, schemaHash: "0".repeat(64) } });
  });
  await page.route("**/api/edit/schema/*", (r) => {
    const cls = new URL(r.request().url()).pathname.split("/").pop();
    return EDIT_SCHEMAS[cls] ? r.fulfill({ json: { class: cls, schema: EDIT_SCHEMAS[cls], sha256: "0".repeat(64), schemaHash: "0".repeat(64) } }) : r.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.route("**/api/changes", (r) => {
    const body = r.request().postDataJSON();
    state.calls.push(body);
    if (body.dry_run) return r.fulfill({ json: { plan: { direct: admin ? body.ops.map((o) => ({ opIds: [o.id], summary: [{ text: `${o.op} ${o.path || o.obj}`, opIds: [o.id] }] })) : [], review: admin ? [] : body.ops.map((o) => ({ opIds: [o.id], summary: [{ text: `${o.op} ${o.path || o.obj}`, opIds: [o.id] }] })) }, warnings: [], errors: [] } });
    return r.fulfill({ status: 201, json: { applied: { versions: {}, undo: null }, summary: [] } });
  });
  return state;
}

const open = async (page, cls, opts, id) => {
  const state = await stub(page, opts);
  await page.goto(`/edit/?cls=${cls.toLowerCase()}&id=${id || ID[cls]}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-hfy-editor-ready]")).toBeVisible();
  return state;
};
const section = async (page, id) => {
  const body = page.locator(`#hfy-sec-${id}-b`);
  if (!(await body.isVisible())) await page.locator(`#hfy-sec-${id}-h button`).click();
  await expect(body).toBeVisible();
  return body;
};
const modes = async (page) => {
  const body = await section(page, "details");
  return [...new Set(await body.locator("[data-hfy-mode]").evaluateAll((els) => els.map((e) => e.getAttribute("data-hfy-mode"))))];
};

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    for (const cls of Object.keys(OBJECTS)) {
      test(`${cls}: opens by gramps id and by h:handle, every field of a member goes to review, the page is accessible`, async ({ page }) => {
        await open(page, cls);
        await expect(page.locator("[data-hfy-subject]")).toContainText(cls.toLowerCase());
        expect(await modes(page)).toEqual(["proposal"]);
        expect(await axeViolations(page)).toEqual([]);
        const byHandle = await page.context().newPage();
        await stub(byHandle);
        await byHandle.goto(`/edit/?cls=${cls.toLowerCase()}&id=h:${OBJECTS[cls].handle}`, { waitUntil: "domcontentloaded" });
        await expect(byHandle.locator("[data-hfy-editor-ready]")).toBeVisible();
        await byHandle.close();
      });
    }

    test("an admin's fields all save now", async ({ page }) => {
      await open(page, "Source", { admin: true });
      expect(await modes(page)).toEqual(["direct"]);
    });

    test("drill-down: event to place, citation to source to repository", async ({ page }) => {
      await open(page, "Event");
      await (await section(page, "related")).locator("[data-hfy-drill-link='place']").click();
      await expect(page).toHaveURL(/cls=place&id=P9001/);
      await expect(page.locator("[data-hfy-editor-ready]")).toBeVisible();
      await page.goto("/edit/?cls=citation&id=C9001", { waitUntil: "domcontentloaded" });
      await expect(page.locator("[data-hfy-editor-ready]")).toBeVisible();
      await (await section(page, "related")).locator("[data-hfy-drill-link='source']").click();
      await expect(page).toHaveURL(/cls=source&id=S9001/);
      await expect(page.locator("[data-hfy-editor-ready]")).toBeVisible();
      await (await section(page, "related")).locator("[data-hfy-drill-link='repository']").click();
      await expect(page).toHaveURL(/cls=repository&id=R9001/);
      await expect(page.locator("[data-hfy-subject]")).toContainText("Synthetic Archive");
    });

    test("place: the type select has no street, building or number; there is no locations tab", async ({ page }) => {
      await open(page, "Place");
      const body = await section(page, "details");
      const options = (await body.getByLabel("kind of place", { exact: true }).locator("option").allTextContents()).join("|").toLowerCase();
      expect(options).not.toMatch(/street|building|number/);
      expect(options).toContain("city");
      await expect(body.locator("[data-pointer*='alt_loc'], [data-pointer*='address']")).toHaveCount(0);
    });

    test("repository: no addresses; its internet-free form is the name and kind", async ({ page }) => {
      await open(page, "Repository");
      const body = await section(page, "details");
      expect(await body.locator("[data-pointer]").evaluateAll((els) => els.map((e) => e.getAttribute("data-pointer")))).toEqual(["/name", "/type", "/tags"]);
      await expect(body).toContainText("we don't keep addresses on the site");
      await expect(page.getByText(/addresses/i).first()).toBeVisible();
      await expect(page.getByRole("heading", { name: /addresses/i })).toHaveCount(0);
    });

    test("tags are picked from the ones that exist and go out as list ops", async ({ page }) => {
      const state = await open(page, "Event");
      const body = await section(page, "details");
      await expect(body.locator("[data-hfy-tag='hst1']")).toBeChecked();
      await body.locator("[data-hfy-tag='hst2']").check();
      await body.locator("[data-hfy-tag='hst1']").uncheck();
      await page.locator("[data-hfy-review]").click();
      await expect(page.locator("[data-hfy-sheet='ready']")).toBeVisible();
      const ops = state.calls[state.calls.length - 1].ops;
      expect(ops.map((o) => [o.op, o.path, o.base ?? o.value])).toEqual([["remove", "/tag_list/@=hst1", "hst1"], ["add", "/tag_list", "hst2"]]);
    });

    test("a styled note: a change outside a style keeps it; a change inside warns and drops it (DEC-E11)", async ({ page }) => {
      const state = await open(page, "Note");
      const body = await section(page, "details");
      const text = body.getByLabel("note", { exact: true });
      await expect(body.locator("[data-hfy-style-note='info']")).toBeVisible();
      await text.fill("Hello bold WORLD and more");
      await expect(body.locator("[data-hfy-style-note='warning']")).toHaveCount(0);
      await text.fill("Hello bXld world and more");
      await expect(body.locator("[data-hfy-style-note='warning']")).toContainText("dropped");
      await page.locator("[data-hfy-review]").click();
      await expect(page.locator("[data-hfy-sheet='ready']")).toBeVisible();
      const op = state.calls[state.calls.length - 1].ops[0];
      expect(op.path).toBe("/text");
      expect(op.value.tags.map((t) => t.ranges)).toEqual([[[21, 25]]]);
    });
  });
}
