// HFY-TSK-156 (flag recordEdit): the person editor's sections at 375 and 1280: names (one given-names input with read-only first and middle, the
// call-name picker), life events (the birth date widget is year and modifier only), facts, notes, photo order, people connected (a person picked
// from the family index, never typed), sources, the place picker with its "not listed" route, the never-in-cloud lines and the waiting-for-review chip.
// Synthetic people only; /auth, /api, the flags file, the person JSON and the family index are stubbed. /api/changes records what the page sends.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/editor-sections.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";
import { EDIT_SCHEMAS } from "../src/lib/edit-schemas.js";

const POLICY = JSON.parse(readFileSync(new URL("./fixtures/edit-policy-all.json", import.meta.url), "utf8"));
const KEY = "Person:hsyn0001";
const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]];

const typed = (cls, value, string = "") => ({ _class: cls, value, string });
const date = (d, m, y, extra = {}) => ({ _class: "Date", calendar: 0, modifier: 0, quality: 0, dateval: [d, m, y, false], text: "", sortval: 2400000, newyear: 0, ...extra });
const ref = (r) => ({ _class: "EventRef", ref: r, role: typed("EventRoleType", 1) });
const OBJ = {
  _class: "Person", handle: "hsyn0001", gramps_id: "I9001",
  primary_name: { _class: "Name", first_name: "Test Quinn", call: "Test", nick: "Tess", surname_list: [{ _class: "Surname", surname: "Person", primary: true }] },
  alternate_names: [{ _class: "Name", first_name: "Tessa", surname_list: [{ _class: "Surname", surname: "Other", primary: true }], type: typed("NameType", 3) }],
  event_ref_list: [ref("hsyne1"), ref("hsyne2")],
  attribute_list: [{ _class: "Attribute", type: typed("AttributeType", 15), value: "Synthetic Worker" }],
  note_list: ["hsynn1"],
  media_list: [{ _class: "MediaRef", ref: "hsynm1" }, { _class: "MediaRef", ref: "hsynm2" }],
  person_ref_list: [{ _class: "PersonRef", ref: "hsynp2", rel: "Godparent" }],
  citation_list: ["hsync1"]
};
const RELATED = {
  "Event:hsyne1": { version: 3, obj: { _class: "Event", handle: "hsyne1", type: typed("EventType", 12), date: date(0, 0, 1950, { modifier: 3 }), place: "hsynl1" } },
  "Event:hsyne2": { version: 5, obj: { _class: "Event", handle: "hsyne2", type: typed("EventType", 19), date: date(0, 0, 2001) } },
  "Place:hsynl1": { version: 1, obj: { _class: "Place", handle: "hsynl1", name: { _class: "PlaceName", value: "Synthville", lang: "" } } },
  "Place:hsynl2": { version: 1, obj: { _class: "Place", handle: "hsynl2", name: { _class: "PlaceName", value: "Exampleton", lang: "" } } },
  "Note:hsynn1": { version: 2, obj: { _class: "Note", handle: "hsynn1", text: { _class: "StyledText", string: "A synthetic note.", tags: [] }, type: typed("NoteType", 1) } },
  "Media:hsynm1": { version: 1, obj: { _class: "Media", handle: "hsynm1", desc: "Front porch" } },
  "Media:hsynm2": { version: 1, obj: { _class: "Media", handle: "hsynm2", desc: "Back garden" } },
  "Person:hsynp2": { version: 1, stub: { displayName: "Sam Example", gender: 1, isLiving: false, lifespan: "1940–2010" } },
  "Citation:hsync1": { version: 4, obj: { _class: "Citation", handle: "hsync1", source_handle: "hsyns1", page: "p. 3", confidence: 2 } },
  "Source:hsyns1": { version: 1, obj: { _class: "Source", handle: "hsyns1", title: "A synthetic ledger" } }
};

const bundle = ({ relation = "own", admin = false, pending = [] } = {}) => ({
  key: KEY, version: 7, etag: `${KEY}@7`, obj: OBJ, related: RELATED, relation, viewer: { admin }, policy: POLICY, pending, customTypes: {}, schemaHash: "0".repeat(64)
});

/** The flags, session, /api/me, /api/edit, the family index, the person lookup and /api/changes in memory. `calls` records every /api/changes body. */
async function stub(page, { relation = "own", admin = false, pending = [], noPerson = false, conflictOnce = false } = {}) {
  const state = { calls: [], lookups: [], keys: [], conflict: conflictOnce };
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: false, profileLinks: false, recordSubsV1: false, recordEdit: true } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: "I9001", grampsId: "I9001", label: "Sam Example" } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [{ grampsId: "I9002", displayName: "Pat Example", lifespanSummary: "1940-2010", isLiving: false }, { grampsId: "I9003", displayName: "Robin Sample", lifespanSummary: "1960-", isLiving: true }] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [{ grampsId: "I9002", searchText: "pat example" }, { grampsId: "I9003", searchText: "robin sample" }] } }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { id: "I9001", label: "Sam Example", admin, can: {}, ownRecord: { cls: "Person", handle: "hsyn0001", gramps_id: "I9001" }, editing: true } }));
  await page.route("**/api/edit/schema/*", (r) => {
    const cls = new URL(r.request().url()).pathname.split("/").pop();
    return EDIT_SCHEMAS[cls] ? r.fulfill({ json: { class: cls, schema: EDIT_SCHEMAS[cls], sha256: "0".repeat(64), schemaHash: "0".repeat(64) } }) : r.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.route("**/api/edit/Person/*", (r) => r.fulfill({ json: bundle({ relation, admin, pending }) }));
  await page.route("**/api/records/Person/by-id/*", (r) => {
    const id = decodeURIComponent(new URL(r.request().url()).pathname.split("/").pop());
    state.lookups.push(id);
    return noPerson ? r.fulfill({ status: 404, json: { error: "not_found" } }) : r.fulfill({ json: { class: "Person", handle: `h${id.toLowerCase()}`, gramps_id: id, version: 1, obj: {} } });
  });
  await page.route("**/api/changes", (r) => {
    const body = r.request().postDataJSON();
    state.calls.push(body);
    state.keys.push(r.request().headers()["idempotency-key"]);
    if (body.dry_run && state.conflict) {
      state.conflict = false;
      return r.fulfill({ status: 409, json: { error: "version_conflict", message: "changed", errors: [] } });
    }
    if (body.dry_run) {
      return r.fulfill({ json: { plan: { direct: body.ops.map((o) => ({ opIds: [o.id], summary: [{ text: `${o.op} ${o.path || o.obj}`, opIds: [o.id] }] })), review: [] }, warnings: [], errors: [] } });
    }
    return r.fulfill({ status: 201, json: { applied: { versions: { [KEY]: 8 }, undo: null }, summary: [] } });
  });
  return state;
}

const open = async (page, opts, query = "?cls=person&id=I9001") => {
  const state = await stub(page, opts);
  await page.goto(`/edit/${query}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-hfy-editor-ready]")).toBeVisible();
  return state;
};
/** Open a section on a phone, where the sections are an accordion; on a wide screen they are all open. */
const section = async (page, id) => {
  const body = page.locator(`#hfy-sec-${id}-b`);
  if (!(await body.isVisible())) await page.locator(`#hfy-sec-${id}-h button`).click();
  await expect(body).toBeVisible();
  return body;
};
const list = (page, id) => page.locator(`[data-hfy-list="${id}"]`);
const row = (page, listId, rowId) => list(page, listId).locator(`[data-hfy-row="${rowId}"]`);
const panel = (page, key) => page.locator(`[data-hfy-panel="${key}"]`);
const openRow = async (page, listId, rowId) => {
  await section(page, listId === "alt" ? "names" : listId);
  await row(page, listId, rowId).locator("[data-hfy-edit]").click();
  return panel(page, rowId);
};
/** The /api/changes dry run the review button sends. */
const review = async (page, state) => {
  await page.locator("[data-hfy-review]").click();
  await expect(page.locator("[data-hfy-sheet='ready']")).toBeVisible();
  return state.calls[state.calls.length - 1];
};

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("names: one given-names input with read-only first and middle; the call-name picker offers the given names only; the last name is its own field", async ({ page }) => {
      await open(page);
      const given = page.getByLabel("given names", { exact: true });
      await expect(given).toHaveValue("Test Quinn");
      await expect(page.locator("[data-hfy-given-first]")).toHaveText("Test");
      await expect(page.locator("[data-hfy-given-middle]")).toHaveText("Quinn");
      // the read-only labels are text, not inputs: the names form holds exactly one box for the given names
      await expect(page.locator("#hfy-sec-names-b input[name='/first_name']")).toHaveCount(1);
      expect(await page.locator("[data-hfy-given] input").count()).toBe(0);
      await given.fill("Test Quinn Rae");
      await expect(page.locator("[data-hfy-given-middle]")).toHaveText("Quinn Rae");
      const call = page.getByLabel("name you go by", { exact: true });
      expect(await call.locator("option").allTextContents()).toEqual(["(none)", "Test", "Quinn", "Rae"]);
      await given.fill("Test");
      expect(await call.locator("option").allTextContents()).toEqual(["(none)", "Test"]);
      await expect(page.getByLabel("last name at birth", { exact: true })).toHaveValue("Person");
    });

    test("names: taking the call name out of the given names clears it; the changes go out as set ops with the keyed surname", async ({ page }) => {
      const state = await open(page);
      await page.getByLabel("given names", { exact: true }).fill("Quinn");
      await expect(page.getByLabel("name you go by", { exact: true })).toHaveValue("");
      await page.getByLabel("last name at birth", { exact: true }).fill("Persona");
      const body = await review(page, state);
      expect(body.ops.map((o) => [o.path.replace(/@k=[0-9a-f]{12}/, "@k=*"), o.base, o.value])).toEqual([
        ["/primary_name/first_name", "Test Quinn", "Quinn"], ["/primary_name/call", "Test", ""], ["/primary_name/surname_list/@k=*/surname", "Person", "Persona"]
      ]);
      expect(body.base_versions).toEqual({ [KEY]: 7 });
    });

    test("events: the birth date widget is a kind and a year, with no month or day, and says why", async ({ page }) => {
      await open(page);
      const p = await openRow(page, "events", "hsyne1");
      const date = p.locator("[data-hfy-date]");
      await expect(date).toHaveAttribute("data-hfy-date", "birth");
      await expect(date.getByLabel("kind", { exact: true })).toHaveValue("3");
      await expect(date.getByLabel("year", { exact: true })).toHaveValue("1950");
      await expect(date.getByLabel("month", { exact: true })).toHaveCount(0);
      await expect(date.getByLabel("day", { exact: true })).toHaveCount(0);
      await expect(date.getByLabel("estimated")).toHaveCount(0);
      await expect(date.locator("[data-hfy-never='birth-date']")).toHaveText("we only keep the birth year on the site.");
      // choosing between adds an end year, still no month or day
      await date.getByLabel("kind", { exact: true }).selectOption("4");
      await expect(date.getByLabel("to year", { exact: true })).toBeVisible();
      await expect(date.getByLabel("month", { exact: true })).toHaveCount(0);
      expect(await axeViolations(page)).toEqual([]);
    });

    test("events: another kind of event has a month, a day and estimated; the date goes out as a version-based set that lists only what changed", async ({ page }) => {
      const state = await open(page);
      const p = await openRow(page, "events", "hsyne2");
      const date = p.locator("[data-hfy-date]");
      await expect(date).toHaveAttribute("data-hfy-date", "date");
      await expect(date.getByLabel("month", { exact: true })).toBeVisible();
      await expect(date.getByLabel("day", { exact: true })).toBeVisible();
      await expect(date.getByLabel("estimated")).toBeVisible();
      await date.getByLabel("month", { exact: true }).selectOption("6");
      const body = await review(page, state);
      expect(body.ops).toHaveLength(1);
      expect(body.ops[0]).toMatchObject({ op: "set", obj: "Event:hsyne2", path: "/date", base_version: 5, sets: ["month"] });
      expect(body.ops[0].value.dateval).toEqual([0, 6, 2001, false]);
      expect(body.base_versions).toEqual({ [KEY]: 7, "Event:hsyne2": 5 });
    });

    test("events: changing a birth to carry a month and a day keeps the year only", async ({ page }) => {
      const state = await open(page);
      const p = await openRow(page, "events", "hsyne2");
      await p.getByLabel("kind of event", { exact: true }).selectOption({ label: "birth" });
      await expect(p.locator("[data-hfy-date]")).toHaveAttribute("data-hfy-date", "birth");
      await expect(p.getByLabel("month", { exact: true })).toHaveCount(0);
      const body = await review(page, state);
      expect(body.ops.map((o) => o.path)).toEqual(["/type"]);
    });

    test("places: the picker lists the bundle's places and a not-listed route to review that creates a new place", async ({ page }) => {
      const state = await open(page);
      const p = await openRow(page, "events", "hsyne2");
      const place = p.getByLabel("place", { exact: true });
      expect(await place.locator("option").allTextContents()).toEqual(["(no place)", "Exampleton", "Synthville", "not listed"]);
      await place.selectOption("__new");
      await expect(p.locator("[data-hfy-review-route='place']")).toContainText("goes to review");
      await p.getByLabel("name of the place", { exact: true }).fill("Newtown");
      const body = await review(page, state);
      expect(body.ops.map((o) => [o.op, o.obj, o.path || o.cls])).toEqual([["create", "new:1", "Place"], ["set", "Event:hsyne2", "/place"]]);
      expect(body.ops[0].value.name.value).toBe("Newtown");
      expect(body.ops[1]).toMatchObject({ base: null, value: "new:1" });
      // a listed place is a plain set
      await page.locator("[data-hfy-back]").click();
      await place.selectOption("hsynl2");
      const again = await review(page, state);
      expect(again.ops.map((o) => [o.op, o.path, o.value])).toEqual([["set", "/place", "hsynl2"]]);
    });

    test("places: choosing not listed alone keeps the place the event has", async ({ page }) => {
      await open(page);
      const p = await openRow(page, "events", "hsyne1");
      await p.getByLabel("place", { exact: true }).selectOption("__new");
      await expect(page.locator("[data-hfy-bar-text]")).toHaveCount(0);
      await p.getByLabel("name of the place", { exact: true }).fill("Newtown");
      await expect(page.locator("[data-hfy-bar-text]")).toContainText("1 change");
    });

    test("events: adding a birth creates the event and its reference in one change; removing one is a keyed remove", async ({ page }) => {
      const state = await open(page);
      await section(page, "events");
      await page.locator("[data-hfy-add='events']").click();
      const p = panel(page, "new:n1");
      await expect(p).toBeVisible();
      await p.getByLabel("kind of event", { exact: true }).selectOption({ label: "census" });
      await p.getByLabel("year", { exact: true }).fill("1999");
      await p.getByLabel("description", { exact: true }).fill("Synthetic census");
      await row(page, "events", "hsyne1").locator("[data-hfy-remove]").click();
      await expect(row(page, "events", "hsyne1")).toHaveAttribute("data-state", "removed");
      await expect(page.locator("[data-hfy-bar-text]")).toContainText("2 changes");
      const body = await review(page, state);
      expect(body.ops.map((o) => [o.op, o.path || o.cls])).toEqual([["remove", "/event_ref_list/@ref=hsyne1"], ["create", "Event"], ["add", "/event_ref_list"]]);
      expect(body.ops[1].value).toMatchObject({ type: typed("EventType", 21), description: "Synthetic census" });
      expect(body.ops[1].value.date.dateval).toEqual([0, 0, 1999, false]);
      expect(body.ops[2].value).toMatchObject({ ref: "new:1", role: typed("EventRoleType", 1) });
      expect(body.base_versions).toEqual({ [KEY]: 7 });
    });

    test("facts and notes: the never-in-cloud line is there; a fact is added and a note edited", async ({ page }) => {
      const state = await open(page);
      await section(page, "facts");
      await expect(list(page, "facts").locator("[data-hfy-never='facts']")).toContainText("we don't keep phone numbers");
      await section(page, "notes");
      await expect(list(page, "notes").locator("[data-hfy-never='notes']")).toContainText("we don't keep phone numbers");
      // the types offered leave out the id numbers
      await section(page, "facts");
      await list(page, "facts").locator("[data-hfy-add]").click();
      const fp = panel(page, "new:n1");
      const labels = await fp.getByLabel("kind of fact", { exact: true }).locator("option").allTextContents();
      expect(labels).toContain("occupation");
      expect(labels.join(" ")).not.toMatch(/social security|identification/);
      await fp.getByLabel("kind of fact", { exact: true }).selectOption({ label: "occupation" });
      await fp.getByLabel("what it is", { exact: true }).fill("Synthetic Teacher");
      const np = await openRow(page, "notes", "hsynn1");
      await np.getByLabel("note", { exact: true }).fill("A synthetic note, edited.");
      const body = await review(page, state);
      expect(body.ops.map((o) => [o.op, o.obj, o.path])).toEqual([["add", KEY, "/attribute_list"], ["set", "Note:hsynn1", "/text"]]);
      expect(body.ops[1].value.string).toBe("A synthetic note, edited.");
      expect(body.base_versions).toEqual({ [KEY]: 7, "Note:hsynn1": 2 });
    });

    test("photos: the first photo is the main one; making another main is a keyed move", async ({ page }) => {
      const state = await open(page);
      await section(page, "photos");
      await expect(row(page, "photos", "hsynm1").locator("[data-hfy-chip='main']")).toBeVisible();
      await row(page, "photos", "hsynm2").locator("[data-hfy-main]").click();
      await expect(list(page, "photos").locator("[data-hfy-row]").first()).toHaveAttribute("data-hfy-row", "hsynm2");
      await expect(page.locator("[data-hfy-bar-text]")).toContainText("1 change");
      const body = await review(page, state);
      expect(body.ops).toHaveLength(1);
      expect(body.ops[0].op).toBe("move");
      expect(body.ops[0].path).toMatch(/^\/media_list\/@ref=hsynm2#0:[0-9a-f]{12}$/);
      expect(body.ops[0].before).toMatch(/^@ref=hsynm1#0:[0-9a-f]{12}$/);
    });

    test("people connected: a person is picked from the family index, never typed; the pick is resolved to a handle", async ({ page }) => {
      const state = await open(page);
      await section(page, "connected");
      await list(page, "connected").locator("[data-hfy-add]").click();
      const p = panel(page, "new:n1");
      const who = p.getByRole("combobox");
      await expect(p.locator("[data-hfy-person-hint]")).toContainText("pick a person from the list");
      // typed text alone is nothing: no person, no op
      await who.fill("Pat Exa");
      await p.getByLabel("how they're connected to you", { exact: true }).fill("Neighbour");
      await expect(page.locator("[data-hfy-bar-text]")).toHaveCount(0);
      const option = p.getByRole("option", { name: /Pat Example/ });
      await expect(option).toBeVisible();
      await option.click();
      await expect(p.locator("[data-hfy-person-picked]")).toContainText("Pat Example");
      expect(state.lookups).toEqual(["I9002"]);
      const body = await review(page, state);
      expect(body.ops).toHaveLength(1);
      expect(body.ops[0]).toMatchObject({ op: "add", obj: KEY, path: "/person_ref_list", value: { _class: "PersonRef", ref: "hi9002", rel: "Neighbour" } });
    });

    test("people connected: a person the records API cannot resolve is not added", async ({ page }) => {
      await open(page, { noPerson: true });
      await section(page, "connected");
      await list(page, "connected").locator("[data-hfy-add]").click();
      const p = panel(page, "new:n1");
      await p.getByRole("combobox").fill("Robin");
      await p.getByRole("option", { name: /Robin Sample/ }).click();
      await expect(p.getByText("we couldn't add that person. try another.")).toBeVisible();
      await expect(p.locator("[data-hfy-person-picked]")).toHaveCount(0);
      await expect(page.locator("[data-hfy-bar-text]")).toHaveCount(0);
    });

    test("people connected and sources: the relation and the page are edited by key, a source is listed or not listed", async ({ page }) => {
      const state = await open(page);
      const cp = await openRow(page, "connected", "hsynp2");
      await cp.getByLabel("how they're connected to you", { exact: true }).fill("Godfather");
      const sp = await openRow(page, "sources", "hsync1");
      await sp.getByLabel("page or place in the source", { exact: true }).fill("p. 4");
      await list(page, "sources").locator("[data-hfy-add]").click();
      const np = panel(page, "new:n1");
      const source = np.getByLabel("source", { exact: true });
      expect(await source.locator("option").allTextContents()).toEqual(["(pick a source)", "A synthetic ledger", "not listed"]);
      await source.selectOption("__new");
      await np.getByLabel("name of the source", { exact: true }).fill("A new ledger");
      const body = await review(page, state);
      expect(body.ops.map((o) => [o.op, o.obj, o.path || o.cls])).toEqual([
        ["set", KEY, "/person_ref_list/@ref=hsynp2/rel"], ["set", "Citation:hsync1", "/page"], ["create", "new:1", "Source"], ["create", "new:2", "Citation"], ["add", KEY, "/citation_list"]
      ]);
      expect(body.base_versions).toEqual({ [KEY]: 7, "Citation:hsync1": 4 });
      await expect(page.locator("[data-hfy-sheet='ready'] [data-hfy-group]").first()).toBeVisible();
    });

    test("also known as: add, change and remove an alternate name by its key", async ({ page }) => {
      const state = await open(page);
      await section(page, "names");
      const rowEl = list(page, "alt").locator("[data-hfy-row]").first();
      await expect(rowEl).toContainText("Tessa Other");
      await rowEl.locator("[data-hfy-remove]").click();
      await list(page, "alt").locator("[data-hfy-add]").click();
      const p = panel(page, "new:n1");
      await p.getByLabel("given names", { exact: true }).fill("Tee");
      await p.getByLabel("last name", { exact: true }).fill("Person");
      const body = await review(page, state);
      expect(body.ops.map((o) => [o.op, o.path.replace(/@k=[0-9a-f]{12}/, "@k=*")])).toEqual([["remove", "/alternate_names/@k=*"], ["add", "/alternate_names"]]);
    });

    test("save: a new note is stored under a key with its versions, and the list draft is cleared so it is not added twice", async ({ page }) => {
      const state = await open(page);
      await section(page, "notes");
      await list(page, "notes").locator("[data-hfy-add]").click();
      await panel(page, "new:n1").getByLabel("note", { exact: true }).fill("A brand new synthetic note.");
      await expect(page.locator("[data-hfy-bar-text]")).toHaveText("1 change — 1 saves now");
      await review(page, state);
      await page.locator("[data-hfy-save]").click();
      await expect(page.locator("[data-hfy-toast-text]")).toHaveText("saved.");
      await expect(page.locator("[data-hfy-bar-text]")).toHaveCount(0);
      await expect(row(page, "notes", "new:n1")).toHaveCount(0);
      const saved = state.calls[state.calls.length - 1];
      expect(saved.dry_run).toBeUndefined();
      expect(saved.ops.map((o) => [o.op, o.obj])).toEqual([["create", "new:1"], ["add", KEY]]);
      expect(state.keys[state.keys.length - 1]).toBeTruthy();
    });

    test("a version conflict on the dry run refetches the page and replays the list changes over it", async ({ page }) => {
      const state = await open(page, { conflictOnce: true });
      await section(page, "notes");
      await list(page, "notes").locator("[data-hfy-add]").click();
      await panel(page, "new:n1").getByLabel("note", { exact: true }).fill("Kept through the conflict.");
      await page.locator("[data-hfy-review]").click();
      await expect(page.locator("[data-hfy-sheet='ready']")).toBeVisible();
      await expect(page.locator("[data-hfy-notice]")).toContainText("this page just changed");
      const second = state.calls[state.calls.length - 1];
      expect(second.dry_run).toBe(true);
      expect(second.ops.find((o) => o.op === "create").value.text.string).toBe("Kept through the conflict.");
      await page.locator("[data-hfy-back]").click();
      await expect(row(page, "notes", "new:n1")).toBeVisible();
    });

    test("opening a row and leaving it alone changes nothing", async ({ page }) => {
      await open(page);
      for (const [listId, rowId] of [["events", "hsyne1"], ["events", "hsyne2"], ["facts", null], ["notes", "hsynn1"], ["connected", "hsynp2"], ["sources", "hsync1"], ["alt", null]]) {
        await section(page, listId === "alt" ? "names" : listId);
        const el = rowId ? row(page, listId, rowId) : list(page, listId).locator("[data-hfy-row]").first();
        await el.locator("[data-hfy-edit]").click();
        await expect(el.locator("[data-hfy-panel]")).toBeVisible();
        await el.locator("[data-hfy-done]").click();
        await expect(page.locator("[data-hfy-bar-text]")).toHaveCount(0);
        await expect(el).not.toHaveAttribute("data-state", "edited");
      }
    });

    test("the waiting-for-review chip shows the proposals the bundle lists, and only those", async ({ page }) => {
      await open(page, { pending: [{ proposalId: "P1", state: "pending", paths: ["/primary_name/nick"] }, { proposalId: "P2", state: "needs_changes", paths: [] }] });
      await expect(page.locator("[data-hfy-pending-chip]")).toHaveText("2 suggested changes waiting for review");
      await expect(page.locator("[data-hfy-pending]")).toHaveText("a change is waiting for review");
    });

    test("no chip when the bundle lists no proposals (a third member's view)", async ({ page }) => {
      await open(page, { relation: "other", pending: [] });
      await expect(page.locator("[data-hfy-pending-chip]")).toHaveCount(0);
      await expect(page.locator("[data-hfy-pending]")).toHaveCount(0);
    });

    test("layout: every list open, every panel open, no horizontal scroll, axe clean", async ({ page }) => {
      await open(page);
      for (const id of ["names", "events", "facts", "notes", "photos", "connected", "sources"]) await section(page, id);
      for (const [listId, rowId] of [["alt", null], ["events", "hsyne2"], ["facts", null], ["notes", "hsynn1"], ["sources", "hsync1"]]) {
        const el = rowId ? row(page, listId, rowId) : list(page, listId).locator("[data-hfy-row]").first();
        await el.locator("[data-hfy-edit]").click();
        await expect(el.locator("[data-hfy-panel]")).toBeVisible();
        // one panel open at a time inside a list; open the date's "between" in the events one to show the widest layout
        if (listId === "events") await el.getByLabel("kind", { exact: true }).selectOption("4");
        const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        expect(m.sw, `${listId} panel`).toBeLessThanOrEqual(m.cw);
        expect(await axeViolations(page), `${listId} panel`).toEqual([]);
      }
      await list(page, "connected").locator("[data-hfy-add]").click();
      await expect(panel(page, "new:n1")).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      const controls = await page.locator(".hfy-editor__body:not([hidden]) :is(input[type=text], select, textarea)").evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height > 0).map((e) => ({ fs: parseFloat(getComputedStyle(e).fontSize), h: e.getBoundingClientRect().height })));
      expect(controls.length).toBeGreaterThan(5);
      for (const c of controls) { expect(c.fs).toBeGreaterThanOrEqual(16); expect(c.h).toBeGreaterThanOrEqual(44); }
      const buttons = await page.locator(".hfy-row__actions button, .hfy-list__add").evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height > 0).map((e) => e.getBoundingClientRect().height));
      for (const h of buttons) expect(h).toBeGreaterThanOrEqual(44);
    });
  });
}

test.describe("an admin", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("changes a date by its value, and a birth still keeps the year only", async ({ page }) => {
    const state = await open(page, { relation: "other", admin: true });
    const p = await openRow(page, "events", "hsyne2");
    await p.locator("[data-hfy-date]").getByLabel("year", { exact: true }).fill("2002");
    const body = await review(page, state);
    expect(body.ops).toHaveLength(1);
    expect(body.ops[0]).toMatchObject({ op: "set", obj: "Event:hsyne2", path: "/date", base: RELATED["Event:hsyne2"].obj.date });
    expect(body.ops[0].base_version).toBeUndefined();
    expect(body.ops[0].value.dateval).toEqual([0, 0, 2002, false]);
  });
});
