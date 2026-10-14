// HFY-TSK-158 (relationship-wizard-island; flag relationshipWizard): /edit/family/ at 375 and 1280, axe clean. The four flows (my parents, my children,
// my spouse or partner, something's wrong) against a mocked API end in the expected intent JSON and a sentence summary before "send for review";
// choice targets measure 56 px or more, inputs 16 px, one question and a step count on each screen; Back and Undo restore the previous draft step
// and a reload keeps the draft (sessionStorage); a duplicate blocks sending until answered; the flag off loads no bundle; the "add or fix family
// connections" button shows on the member's own page only. Synthetic people only; /auth, /api, the flags file and the people index are stubbed.
//   HFY_SITE=<dir> PW_PORT=<port> npx playwright test tests/family-wizard.spec.mjs
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
const VIEWPORTS = [["375", { width: 375, height: 812 }], ["1280", { width: 1280, height: 800 }]];
const FLAGS = { authV2: true, shellV2: false, personV2: false, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, photoTags: false, profileLinks: false, recordSubsV1: false };
const ME = "I9001";

const person = (first, surname, extra = {}) => ({ _class: "Person", primary_name: { first_name: first, surname_list: [{ surname }] }, ...extra });
const REC = {
  "Person/hsyn0001": { handle: "hsyn0001", gramps_id: "I9001", obj: person("Sam", "Example", { parent_family_list: ["hf1"], family_list: ["hf2"] }) },
  "Person/hsyn0002": { handle: "hsyn0002", gramps_id: "I9002", obj: person("Tessa", "Example") },
  "Person/hsyn0003": { handle: "hsyn0003", gramps_id: "I9003", obj: person("Orrin", "Example") },
  "Person/hsyn0004": { handle: "hsyn0004", gramps_id: "I9004", obj: person("Wren", "Example") },
  "Person/hsyn0005": { handle: "hsyn0005", gramps_id: "I9005", obj: person("Alex", "Example") },
  "Person/hsyn0006": { handle: "hsyn0006", gramps_id: "I9006", obj: person("Jo", "Example") },
  "Family/hf1": { handle: "hf1", gramps_id: "F9001", obj: { father_handle: "hsyn0003", mother_handle: "hsyn0002", child_ref_list: [{ ref: "hsyn0001" }] } },
  "Family/hf2": { handle: "hf2", gramps_id: "F9002", obj: { father_handle: "hsyn0001", mother_handle: "hsyn0005", child_ref_list: [{ ref: "hsyn0004" }] } },
};
const PEOPLE = [
  { grampsId: "I9002", displayName: "Tessa Example", lifespanSummary: "1950 - 2010" },
  { grampsId: "I9003", displayName: "Orrin Example", lifespanSummary: "1948 -" },
  { grampsId: "I9004", displayName: "Wren Example", lifespanSummary: "2015 -" },
  { grampsId: "I9005", displayName: "Alex Example", lifespanSummary: "1975 -" },
  { grampsId: "I9006", displayName: "Jo Example", lifespanSummary: "2018 -" },
];
const DOCS = PEOPLE.map((p) => ({ grampsId: p.grampsId, searchText: p.displayName }));

const defaultPreview = (body) => ({
  ops: [], base_versions: {}, read_versions: {}, summary: [{ text: "the site's own sentence", opIds: [] }], warnings: [], duplicates: [], followUps: [],
  destructive: body.intent.type === "unlink", already_recorded: false, route: "proposal", subject: body.intent.person,
});

/** The stubbed world. `preview(body, s)` / `post(body, headers, s)` may answer themselves (return a Playwright fulfill object). Every relationship call is recorded. */
async function stub(page, { flag = true, session = ME, editing = true, ownRecord = { cls: "Person", handle: "hsyn0001", gramps_id: ME }, preview = null, post = null } = {}) {
  const s = { previews: [], posts: [], islandRequests: [], recordGets: [], places: 0 };
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { ...FLAGS, relationshipWizard: flag } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: session ? { authenticated: true, sub: session, grampsId: session, label: "Sam Example" } : { authenticated: false } }));
  await page.route("**/auth/refresh", (r) => r.fulfill({ status: 401, json: { error: "no refresh" } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: PEOPLE } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: DOCS } }));
  await page.route(/\/js\/islands\/family/, (r) => { s.islandRequests.push(new URL(r.request().url()).pathname); return r.continue(); });
  await page.route("**/person/I9001.json", (r) => r.fulfill({ json: PERSON }));
  await page.route("**/media/tree_I9001.svg", (r) => r.fulfill({ contentType: "image/svg+xml", body: readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8") }));
  await page.route(/\/media\/MPHOTO\d\.jpg/, (r) => r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="gray"/></svg>' }));
  await page.route("**/api/me", (r) => r.fulfill(session ? { json: { id: session, label: "Sam Example", admin: false, can: {}, editing, ...(ownRecord ? { ownRecord } : {}) } } : { status: 401, json: { error: "unauthenticated" } }));
  await page.route("**/api/comments**", (r) => r.fulfill({ json: { thread: { id: "x", topic: "comments", comments: [], reactions: {} } } }));
  await page.route("**/api/records/**", (r) => {
    const parts = new URL(r.request().url()).pathname.split("/").filter(Boolean); // api, records, Class, handle | by-id, gid
    s.recordGets.push(parts.slice(2).join("/"));
    const hit = parts[3] === "by-id" ? Object.values(REC).find((x) => x.gramps_id === parts[4] && x.obj.primary_name) : REC[`${parts[2]}/${parts[3]}`];
    return hit ? r.fulfill({ json: { class: parts[2], ...hit, version: 3 } }) : r.fulfill({ status: 404, json: { error: "not_found" } });
  });
  await page.route("**/api/edit/Person/*", (r) => { s.places += 1; return r.fulfill({ json: { key: "Person:hsyn0001", obj: REC["Person/hsyn0001"].obj, related: { "Place:hp1": { version: 1, obj: { name: { value: "Springfield" } } } } } }); });
  await page.route("**/api/relationships/preview", async (r) => {
    const body = r.request().postDataJSON();
    s.previews.push(body);
    if (preview) { const a = await preview(body, s); if (a) return r.fulfill(a); }
    return r.fulfill({ json: defaultPreview(body) });
  });
  await page.route(/\/api\/relationships$/, async (r) => {
    const body = r.request().postDataJSON();
    const headers = await r.request().allHeaders();
    s.posts.push({ body, headers });
    if (post) { const a = await post(body, headers, s); if (a) return r.fulfill(a); }
    return r.fulfill({ status: 201, json: { proposal: { id: "01HZ0000000000000000000001", state: "pending" } } });
  });
  return s;
}

const open = async (page, opts, query = `?id=${ME}`) => {
  const s = await stub(page, opts);
  await page.goto(`/edit/family/${query}`, { waitUntil: "domcontentloaded" });
  return s;
};
const ready = (page) => expect(page.locator("[data-hfy-wizard-ready]")).toBeVisible();
const screen = (page, id) => expect(page.locator(`[data-hfy-screen="${id}"]`)).toBeVisible();
const choice = (page, text) => page.locator("[data-hfy-choice]", { hasText: text }).first();
const pick = (page, text) => choice(page, text).click();
const search = async (page, text, row) => {
  await page.locator("[data-hfy-search]").fill(text);
  await page.locator(`[data-hfy-person="${row}"]`).click();
};
const sentences = (page) => page.locator("[data-hfy-sentence]");
const newPerson = async (page, { given, surname, birthYear, living }) => {
  await page.locator("[data-hfy-new]").click();
  await page.locator("[data-hfy-given]").fill(given);
  if (surname) await page.locator("[data-hfy-surname]").fill(surname);
  if (birthYear) await page.locator("[data-hfy-birth-year]").fill(birthYear);
  if (living) await page.locator(`[data-hfy-living="${living}"]`).check();
  await page.locator("[data-hfy-continue]").click();
};

test.describe("flag off (AC5)", () => {
  test("no wizard bundle is requested on /edit/family/ or on the person page, and the page keeps its note", async ({ page }) => {
    const s = await open(page, { flag: false });
    await expect(page.locator("[data-family-off]")).toHaveText("family connections aren't available yet.");
    await page.waitForTimeout(500);
    await page.goto(`/person/?id=${ME}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#person-hero h1")).toBeVisible();
    await page.waitForTimeout(500);
    expect(s.islandRequests).toEqual([]);
    await expect(page.locator("[data-hfy-family-entry]")).toHaveCount(0);
  });
});

test.describe("signed out, editing off, someone else's page", () => {
  test("signed out: the sign-in line", async ({ page }) => {
    await open(page, { session: null });
    await expect(page.locator("[data-hfy-gate]")).toContainText("sign in to add or fix family connections.");
    await expect(page.locator("[data-hfy-gate] a")).toHaveAttribute("href", /^\/auth\/login\?returnTo=/);
  });
  test("with editing off at the API the page says so", async ({ page }) => {
    await open(page, { editing: false });
    await expect(page.locator(".hfy-wizpage")).toContainText("family connections aren't turned on yet.");
  });
  test("another person's id points the member to their own page", async ({ page }) => {
    await open(page, {}, "?id=I9002");
    await expect(page.locator("[data-hfy-not-yours]")).toContainText("this is for your own page");
    await expect(page.locator("[data-hfy-not-yours] a")).toHaveAttribute("href", "/person/?id=I9001");
  });
  test("no id means the member's own page", async ({ page }) => {
    await open(page, {}, "");
    await screen(page, "start");
  });
});

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`${name}px`, () => {
    test.use({ viewport });

    test("my parents: a picked mother and a new father end in the intent, the sentences and one send (AC1)", async ({ page }) => {
      const s = await open(page);
      await screen(page, "start");
      await expect(page.locator("[data-hfy-flow]")).toHaveText(["my parents", "my children", "my spouse or partner", "something's wrong"].map((t) => new RegExp(t)));
      await pick(page, "my parents");
      await screen(page, "p.which");
      await pick(page, "my mother");
      await search(page, "Tessa", "I9002");
      await screen(page, "p.rel");
      await expect(page.locator("[data-hfy-q]")).toHaveText("how are you related to her?");
      await pick(page, "birth mother");
      await screen(page, "p.more");
      await pick(page, "add another parent");
      await expect(page.locator('[data-hfy-role="mother"]')).toHaveCount(0);
      await pick(page, "my father");
      await newPerson(page, { given: "Orrin Lee", surname: "Example", birthYear: "1948", living: "yes" });
      await pick(page, "adoptive father");
      await screen(page, "summary");
      expect(s.previews).toHaveLength(1);
      expect(s.previews[0]).toEqual({
        intent: {
          type: "parents", person: "Person:hsyn0001",
          parents: [
            { who: { ref: "Person:hsyn0002" }, rel: "birth" },
            { who: { new: { given: "Orrin Lee", surname: "Example", gender: "male", birthYear: 1948, living: "yes", deathYear: null } }, rel: "adopted" },
          ],
        },
      });
      await expect(sentences(page)).toHaveText([/Tessa Example is your birth mother\./, /Orrin Lee Example is your adoptive father\./, /they are listed together as your parents\./]);
      await expect(page.locator("[data-hfy-admin-line]")).toHaveText("an admin will check this before it shows on the site. you'll get a notification.");
      // P2-R46: a person on the site is a link to their page; a new person is plain text
      await expect(sentences(page).first().locator("a.hfy-person-name")).toHaveAttribute("href", "/person/?id=I9002");
      await expect(sentences(page).nth(1).locator("a.hfy-person-name")).toHaveCount(0);
      expect(s.posts).toHaveLength(0);
      await page.locator("[data-hfy-send]").click();
      await expect(page.locator("[data-hfy-sent]")).toContainText("sent. you can change or withdraw it until an admin looks.");
      expect(s.posts).toHaveLength(1);
      expect(s.posts[0].body).toEqual({ intent: s.previews[0].intent, confirmDistinct: [] });
      expect(s.posts[0].headers["idempotency-key"]).toMatch(/^[0-9a-f-]{16,}$/);
      await expect(page.locator("[data-hfy-see-sent]")).toHaveAttribute("href", "/me/review/?tab=mine");
      expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("hfy:wizard")))).toEqual([]);
    });

    test("my children: the partner is pre-listed; a picked and a new child; a changed relation (AC1)", async ({ page }) => {
      const s = await open(page);
      await pick(page, "my children");
      await screen(page, "c.other");
      await expect(page.locator('[data-hfy-partner="hsyn0005"]')).toHaveText("Alex Example");
      await page.locator('[data-hfy-partner="hsyn0005"]').click();
      await screen(page, "c.add");
      await expect(page.locator("[data-hfy-empty]")).toBeVisible();
      await page.locator("[data-hfy-add-kid]").click();
      await search(page, "Wren", "I9004");
      await expect(page.locator("[data-hfy-kid]")).toHaveCount(1);
      await page.locator("[data-hfy-add-kid]").click();
      await newPerson(page, { given: "Lark", surname: "Example", birthYear: "2020", living: "yes" });
      await expect(page.locator("[data-hfy-kid]")).toHaveCount(2);
      await page.locator("[data-hfy-kids-done]").click();
      await screen(page, "c.rel");
      await page.locator("[data-hfy-kid] [data-hfy-change]").nth(1).click();
      await expect(page.locator("[data-hfy-q]")).toHaveText("how is Lark Example related to you?");
      await pick(page, "adopted child");
      await expect(page.locator("[data-hfy-q]")).toHaveText("how is Lark Example related to Alex Example?");
      await pick(page, "stepchild");
      await page.locator("[data-hfy-looks-right]").click();
      await screen(page, "summary");
      expect(s.previews[0].intent).toEqual({
        type: "children", person: "Person:hsyn0001", otherParent: { ref: "Person:hsyn0005" },
        children: [
          { who: { ref: "Person:hsyn0004" }, relToMe: "birth", relToOther: "birth" },
          { who: { new: { given: "Lark", surname: "Example", gender: "unknown", birthYear: 2020, living: "yes", deathYear: null } }, relToMe: "adopted", relToOther: "step" },
        ],
      });
      await expect(sentences(page)).toHaveText([/Wren Example is the birth child of you and Alex Example\./, /Lark Example is your adopted child, and the stepchild of Alex Example\./]);
      await page.locator("[data-hfy-send]").click();
      await expect(page.locator("[data-hfy-sent]")).toBeVisible();
      expect(s.posts[0].body.intent.type).toBe("children");
    });

    test("my spouse or partner: married, a year, a place the site has, divorced (AC1)", async ({ page }) => {
      const s = await open(page);
      await pick(page, "my spouse or partner");
      await search(page, "Alex", "I9005");
      await pick(page, "yes, married");
      await screen(page, "s.year");
      await page.locator("[data-hfy-year]").fill("1990");
      await page.locator("[data-hfy-about]").check();
      await page.locator("[data-hfy-continue]").click();
      await screen(page, "s.place");
      await page.locator('[data-hfy-place="Place:hp1"]').click();
      await expect(page.locator("[data-hfy-q]")).toHaveText("is the marriage still going?");
      await pick(page, "no, we split up");
      await page.locator("[data-hfy-year]").fill("2001");
      await page.locator("[data-hfy-continue]").click();
      await screen(page, "summary");
      expect(s.previews[0].intent).toEqual({
        type: "spouse", person: "Person:hsyn0001", spouse: { ref: "Person:hsyn0005" }, relType: "married",
        married: { year: 1990, about: true, place: { ref: "Place:hp1" } }, ended: { how: "divorced", year: 2001 },
      });
      await expect(sentences(page)).toHaveText([/you and Alex Example are married\./, /you married in about 1990 in Springfield\./, /you are no longer together \(2001\)\./]);
      await page.locator("[data-hfy-send]").click();
      await expect(page.locator("[data-hfy-sent]")).toBeVisible();
      expect(s.posts[0].body.intent.spouse).toEqual({ ref: "Person:hsyn0005" });
    });

    test("something's wrong: the connections to take off; the unlink needs a yes (AC1)", async ({ page }) => {
      const s = await open(page);
      await pick(page, "something's wrong");
      await screen(page, "u.list");
      await expect(page.locator("[data-hfy-unlink]")).toHaveText([/Orrin Example and Tessa Example as your parents|Tessa Example and Orrin Example as your parents/, /Alex Example as your spouse or partner/, /Wren Example as your child/]);
      await page.locator('[data-hfy-unlink="partner"]').click();
      await screen(page, "u.confirm");
      await expect(sentences(page)).toHaveText(["take off Alex Example as your spouse or partner."]);
      await pick(page, "no, keep it");
      await screen(page, "u.list");
      await page.locator('[data-hfy-unlink="partner"]').click();
      await pick(page, "yes, take it off");
      await screen(page, "summary");
      expect(s.previews[0].intent).toEqual({ type: "unlink", family: "Family:hf2", person: "Person:hsyn0001", as: "partner" });
      await expect(page.locator("[data-hfy-destructive]")).toBeVisible();
      await page.locator("[data-hfy-send]").click();
      await expect(page.locator("[data-hfy-sent]")).toBeVisible();
      expect(s.posts[0].body).toEqual({ intent: s.previews[0].intent, confirmDistinct: [] });
    });

    test("choice targets are 56 px or more, inputs are 16 px, one question and a step count on each screen (AC2)", async ({ page }) => {
      await open(page);
      await screen(page, "start");
      const measure = async () => page.evaluate(() => ({
        choices: [...document.querySelectorAll("[data-hfy-choice]")].map((e) => e.getBoundingClientRect().height),
        actions: [...document.querySelectorAll("[data-hfy-action]")].map((e) => e.getBoundingClientRect().height),
        inputs: [...document.querySelectorAll("input[type=text], input[type=search]")].map((e) => [parseFloat(getComputedStyle(e).fontSize), e.getBoundingClientRect().height]),
        questions: document.querySelectorAll("[data-hfy-q]").length,
        step: (document.querySelector("[data-hfy-step]") || {}).textContent || null,
      }));
      const check = async (stepText) => {
        const m = await measure();
        expect(m.choices.length).toBeGreaterThan(0);
        for (const h of m.choices) expect(h).toBeGreaterThanOrEqual(56);
        for (const h of m.actions) expect(h).toBeGreaterThanOrEqual(56);
        for (const [font] of m.inputs) expect(font).toBeGreaterThanOrEqual(16);
        expect(m.questions, "one question per screen").toBe(1);
        expect(m.step).toBe(stepText);
      };
      await check(null); // the start has no count
      await pick(page, "my parents");
      await check("step 1 of 4");
      await pick(page, "my mother");
      await check("step 2 of 4");
      await page.locator("[data-hfy-search]").fill("Te");
      await page.locator('[data-hfy-person="I9002"]').waitFor();
      await check("step 2 of 4");
      await page.locator("[data-hfy-new]").click();
      const m = await measure();
      expect(m.inputs.length).toBe(3);
      for (const [font, h] of m.inputs) { expect(font).toBeGreaterThanOrEqual(16); expect(h).toBeGreaterThanOrEqual(56); }
      expect(m.questions).toBe(1);
      for (const h of await page.locator("[data-hfy-new-form] label[data-hfy-choice]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(56);
      await page.locator("[data-hfy-given]").fill("Tess");
      await page.locator("[data-hfy-continue]").click();
      await check("step 3 of 4");
    });

    test("Back and Undo restore the previous draft step, and a reload keeps the draft (AC3)", async ({ page }) => {
      await open(page);
      await pick(page, "my children");
      await pick(page, "I'd rather not say");
      await screen(page, "c.add");
      await page.locator("[data-hfy-add-kid]").click();
      await search(page, "Wren", "I9004");
      await page.locator("[data-hfy-add-kid]").click();
      await search(page, "Jo", "I9006");
      await expect(page.locator("[data-hfy-kid]")).toHaveCount(2);
      // Undo takes the last answer back: the second child is gone
      await page.locator("[data-hfy-undo]").click();
      await screen(page, "c.child");
      await page.locator("[data-hfy-undo]").click();
      await expect(page.locator("[data-hfy-kid]")).toHaveCount(1);
      await screen(page, "c.add");
      // a reload keeps the screen and the draft
      await page.reload({ waitUntil: "domcontentloaded" });
      await screen(page, "c.add");
      await expect(page.locator("[data-hfy-kid]")).toHaveCount(1);
      await expect(page.locator("[data-hfy-kid]").first()).toContainText("Wren Example");
      expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("hfy:wizard:v1:")))).toEqual([`hfy:wizard:v1:${ME}`]);
      // Back retraces the way here, screen by screen, to the start
      await page.locator("[data-hfy-back]").click();
      await screen(page, "c.child");
      await page.locator("[data-hfy-back]").click();
      await screen(page, "c.add");
      await expect(page.locator("[data-hfy-empty]")).toBeVisible();
      await page.locator("[data-hfy-back]").click();
      await screen(page, "c.other");
      await page.locator("[data-hfy-back]").click();
      await screen(page, "start");
      await expect(page.locator("[data-hfy-back]")).toHaveCount(0);
      await page.reload({ waitUntil: "domcontentloaded" });
      await screen(page, "start");
    });

    test("a duplicate blocks sending until it is answered (AC4)", async ({ page }) => {
      const dup = { for: "new:1", candidates: [{ handle: "hsyn0006", displayName: "Jo Exampel", lifespan: "2018-" }] };
      const s = await open(page, {
        preview: (body) => {
          const stubs = JSON.stringify(body.intent).includes('"new"');
          const confirmed = (body.confirmDistinct || []).includes("new:1");
          return stubs && !confirmed ? { json: { ...defaultPreview(body), duplicates: [dup] } } : null;
        },
      });
      await pick(page, "my spouse or partner");
      await newPerson(page, { given: "Jo", surname: "Example", birthYear: "2018" });
      await pick(page, "partners, not married");
      await pick(page, "yes, still together");
      await screen(page, "dup");
      await expect(page.locator("[data-hfy-q]")).toHaveText("is this the same person?");
      await expect(page.locator("[data-hfy-blocked]")).toBeVisible();
      await expect(page.locator("[data-hfy-send]")).toHaveCount(0);
      expect(s.posts).toHaveLength(0);
      expect(await axeViolations(page)).toEqual([]);
      // "no, someone else": checked again with confirmDistinct, then the summary can be sent
      await page.locator("[data-hfy-different]").click();
      await screen(page, "summary");
      expect(s.previews.at(-1).confirmDistinct).toEqual(["new:1"]);
      await page.locator("[data-hfy-send]").click();
      await expect(page.locator("[data-hfy-sent]")).toBeVisible();
      expect(s.posts[0].body.confirmDistinct).toEqual(["new:1"]);
      expect(s.posts[0].body.intent.spouse.new.given).toBe("Jo");
    });

    test("'yes, that's them' swaps the new person for the one on the site (AC4)", async ({ page }) => {
      const dup = { for: "new:1", candidates: [{ handle: "hsyn0006", displayName: "Jo Example", lifespan: "2018-" }] };
      const s = await open(page, { preview: (body) => (JSON.stringify(body.intent).includes('"new"') ? { json: { ...defaultPreview(body), duplicates: [dup] } } : null) });
      await pick(page, "my spouse or partner");
      await newPerson(page, { given: "Jo", surname: "Example" });
      await pick(page, "partners, not married");
      await pick(page, "yes, still together");
      await screen(page, "dup");
      await page.locator('[data-hfy-same="hsyn0006"]').click();
      await screen(page, "summary");
      expect(s.previews.at(-1).intent.spouse).toEqual({ ref: "Person:hsyn0006" });
      await page.locator("[data-hfy-send]").click();
      await expect(page.locator("[data-hfy-sent]")).toBeVisible();
      expect(s.posts[0].body.intent.spouse).toEqual({ ref: "Person:hsyn0006" });
      expect(s.posts[0].body.confirmDistinct).toEqual([]);
    });

    test("a send the server refuses says why in plain words and can be tried again (AC1)", async ({ page }) => {
      let n = 0;
      const s = await open(page, { post: () => (n++ === 0 ? { status: 422, json: { error: "cycle", message: "that would make someone their own ancestor" } } : null) });
      await pick(page, "my parents");
      await pick(page, "my mother");
      await search(page, "Tessa", "I9002");
      await pick(page, "birth mother");
      await pick(page, "that's all");
      await page.locator("[data-hfy-send]").click();
      await expect(page.locator("[data-hfy-send-problem]")).toContainText("it would make someone their own ancestor");
      await page.locator("[data-hfy-send]").click();
      await expect(page.locator("[data-hfy-sent]")).toBeVisible();
      expect(s.posts).toHaveLength(2);
      expect(s.posts[1].headers["idempotency-key"]).toBe(s.posts[0].headers["idempotency-key"]);
    });

    test("axe is clean and nothing scrolls sideways on the start, a question, the form and the summary (AC5)", async ({ page }) => {
      await open(page);
      const noSideScroll = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await screen(page, "start");
      expect(await axeViolations(page)).toEqual([]);
      await noSideScroll();
      await pick(page, "my parents");
      await pick(page, "my mother");
      expect(await axeViolations(page)).toEqual([]);
      await page.locator("[data-hfy-search]").fill("Te");
      await page.locator('[data-hfy-person="I9002"]').waitFor();
      expect(await axeViolations(page)).toEqual([]);
      await noSideScroll();
      await page.locator("[data-hfy-new]").click();
      await page.locator("[data-hfy-given]").fill("A very long first name ".repeat(4));
      await page.locator("[data-hfy-living='no']").check();
      expect(await axeViolations(page)).toEqual([]);
      await noSideScroll();
      await page.locator("[data-hfy-given]").fill("Tess");
      await page.locator("[data-hfy-continue]").click();
      await pick(page, "birth mother");
      await pick(page, "that's all");
      await screen(page, "summary");
      expect(await axeViolations(page)).toEqual([]);
      await noSideScroll();
      await page.locator("[data-hfy-send]").click();
      await expect(page.locator("[data-hfy-sent]")).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
      await noSideScroll();
    });

    test("the form refuses a phone number in a name and a bad year, in plain words", async ({ page }) => {
      await open(page);
      await pick(page, "my parents");
      await pick(page, "my mother");
      await page.locator("[data-hfy-new]").click();
      await page.locator("[data-hfy-given]").fill("Tess 555-867-5309");
      await expect(page.locator("[data-hfy-guard]")).toBeVisible();
      await expect(page.locator("[data-hfy-continue]")).toBeDisabled();
      await page.locator("[data-hfy-given]").fill("Tess");
      await page.locator("[data-hfy-birth-year]").fill("19x0");
      await page.locator("[data-hfy-continue]").click();
      await expect(page.locator("#" + (await page.locator("[data-hfy-birth-year]").getAttribute("aria-describedby")))).toHaveText("use a four-digit year.");
      await expect(page.locator("[data-hfy-q]")).toHaveText("who is your mother?");
    });
  });
}

test.describe("the family panel (1280)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("from 64rem a text list of what the member has said, beside the question", async ({ page }) => {
    await open(page);
    await expect(page.locator("[data-hfy-panel]")).toBeVisible();
    await expect(page.locator("[data-hfy-panel]")).toContainText("nothing yet.");
    await pick(page, "my parents");
    await pick(page, "my mother");
    await search(page, "Tessa", "I9002");
    await pick(page, "stepmother");
    await expect(page.locator("[data-hfy-panel] li")).toHaveText(["Tessa Example is your stepmother."]);
    expect(await page.locator("[data-hfy-panel] svg").count()).toBe(0);
  });
});

test.describe("the panel is for wide pages (375)", () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test("under 64rem it is not shown", async ({ page }) => {
    await open(page);
    await expect(page.locator("[data-hfy-panel]")).toBeHidden();
  });
});

for (const [name, viewport] of VIEWPORTS) {
  test.describe(`the family-section button, ${name}px`, () => {
    test.use({ viewport });
    test("on the member's own page only (AC5)", async ({ page }) => {
      await stub(page);
      await page.goto(`/person/?id=${ME}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("#person-hero h1")).toHaveText("Test Person (synthetic)");
      const btn = page.locator("#person-family-section [data-slot=\"family-edit\"] a.hfy-family-entry");
      await expect(btn).toHaveText("add or fix family connections");
      await expect(btn).toHaveAttribute("href", "/edit/family/?id=I9001");
      expect((await btn.boundingBox()).height).toBeGreaterThanOrEqual(56);
      expect(await axeViolations(page, { include: "#person-family-section" })).toEqual([]);
    });
    test("not on another member's page, nor when signed out, nor with editing off", async ({ page }) => {
      for (const opts of [{ session: "I9002", ownRecord: { cls: "Person", handle: "hsyn0002", gramps_id: "I9002" } }, { session: null }, { editing: false }]) {
        const p = await page.context().newPage();
        await stub(p, opts);
        await p.goto(`/person/?id=${ME}`, { waitUntil: "domcontentloaded" });
        await expect(p.locator("#person-hero h1")).toHaveText("Test Person (synthetic)");
        await p.waitForTimeout(500);
        await expect(p.locator("[data-hfy-family-entry]")).toHaveCount(0);
        await p.close();
      }
    });
  });
}
