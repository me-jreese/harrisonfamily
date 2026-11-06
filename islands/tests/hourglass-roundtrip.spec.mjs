// HFY-TSK-379 pass 4: the round trip between the hourglass trees and the card views, hop by hop, in a real browser on the invented people of
// fixtures/tree-graph-hourglass.json (flag familyVizHourglass; DIGEST section 5, T-Both). Every hop is a real address that carries the person.
//   person page, small tree -> tap the middle person -> big tree centred on them -> "see this as cards" -> family page, cards, centred on them
//   -> "see {first} in the tree" -> the big tree -> browser Back, Back, Back -> the person page where it started.
// Flags, /person/graph.json, the person JSON, the session and media are route-stubbed; nothing here is real data.
//   PW_CHANNEL=chromium-headless-shell HFY_SITE=<dir> PW_PORT=<free port> npx playwright test tests/hourglass-roundtrip.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { CASES, GRAPH } from "./fixtures/hourglass-cases.mjs";

// The site's service worker would answer chunk requests itself, past the route stubs below.
test.use({ serviceWorkers: "block" });

const PERSON = JSON.parse(readFileSync(new URL("./fixtures/person-legacy.json", import.meta.url), "utf8"));
const TREE = readFileSync(new URL("./fixtures/tree-synthetic.svg", import.meta.url), "utf8");
const NAME = Object.fromEntries(GRAPH.people.map((p) => [p.id, p.name]));
const FIRST = (id) => NAME[id].split(" ")[0];

const FLAGS = (o) => ({ authV2: true, shellV2: true, personV2: true, postsV2: false, searchV2: false, notifyV2: false, navMe: false, aboutCta: false, familyViz: true, familyVizPersonMini: false, familyVizHourglass: true, familyVizKinship: false, familyVizTime: true, familyVizBigTree: false, chatV1: false, ...o });

async function stub(page, flags = {}) {
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: FLAGS(flags) }));
  await page.route("**/person/graph.json", (r) => r.fulfill({ status: 200, json: GRAPH }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: "I9002", grampsId: "I9002", label: "Sam Example" } }));
  await page.route("**/api/**", (r) => r.fulfill({ json: { thread: { id: "x", topic: "comments", comments: [], reactions: {} } } }));
  await page.route("**/person/index.json", (r) => r.fulfill({ json: { people: [] } }));
  await page.route("**/person/search-index.json", (r) => r.fulfill({ json: { documents: [] } }));
  await page.route(/\/person\/I\d+\.json$/, (r) => {
    const id = /(I\d+)\.json$/.exec(r.request().url())[1];
    return r.fulfill({ json: { ...PERSON, grampsId: id, handle: `h${id}`, displayName: NAME[id] || "Missing Person", familyTreeMedia: { path: `tree_${id}.svg` } } });
  });
  await page.route(/\/media\/tree_I\d+\.svg$/, (r) => r.fulfill({ contentType: "image/svg+xml", body: TREE }));
  await page.route(/\/media\/faces\//, (r) => r.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="gray"/></svg>' }));
}

const where = (page) => page.evaluate(() => ({ path: location.pathname, ...Object.fromEntries(new URLSearchParams(location.search)) }));

for (const width of [375, 1280]) {
  test(`person page -> big tree -> cards -> big tree -> back, back, back at ${width}: each hop is a real address with the person in it`, async ({ page }) => {
    const id = CASES.full;
    const first = FIRST(id);
    await page.setViewportSize({ width, height: 1000 });
    await stub(page);
    await page.goto(`/person/?id=${id}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#person-hero h1")).toHaveText(NAME[id]);

    // 1. the small tree: the middle person is a real link to the big tree centred on them
    const middle = page.locator(".hfy-tree .hfy-tree__card.is-focus a[href*='view=tree'], .hfy-tree a.hfy-tree__card.is-focus").first();
    await expect(middle).toBeVisible();
    await expect(middle).toHaveAttribute("href", `/tree/?view=tree&focus=${id}&from=${id}`);
    await middle.click();

    // 2. the big tree, centred on them
    await expect(page.locator('.hfy-bt [aria-current="true"]')).toHaveAttribute("aria-label", `${NAME[id]}, in the middle now`);
    expect(await where(page)).toEqual({ path: "/tree/", view: "tree", focus: id, from: id });
    await expect(page.locator("[data-tree-ctx]")).toContainText(`centred on ${NAME[id]}`);

    // 3. "see this as cards": the family page, cards, with them in front
    await page.locator(".hfy-bt__bar").getByRole("link", { name: "cards", exact: true }).click();
    await expect(page.locator("[data-tree-focus]")).toBeVisible();
    await expect(page.locator("family-navigator [data-person]").first()).toBeVisible();
    expect(await where(page)).toEqual({ path: "/tree/", view: "cards", focus: id });
    await expect(page.locator("[data-tree-ctx]")).toContainText(`centred on ${NAME[id]}`);
    await expect(page.locator("#hfy-tree-focus-name")).toHaveText(NAME[id]);

    // 4. "see {first} in the tree": the big tree again, from= the same person
    await page.getByRole("link", { name: `see ${first} in the tree` }).click();
    await expect(page.locator('.hfy-bt [aria-current="true"]')).toHaveAttribute("aria-label", `${NAME[id]}, in the middle now`);
    expect(await where(page)).toEqual({ path: "/tree/", view: "tree", focus: id, from: id });

    // 5. back, back, back: the cards, the first big tree, the person page where it started
    await page.goBack({ waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-tree-focus]")).toBeVisible();
    expect(await where(page)).toEqual({ path: "/tree/", view: "cards", focus: id });
    await page.goBack({ waitUntil: "domcontentloaded" });
    await expect(page.locator('.hfy-bt [aria-current="true"]')).toBeVisible();
    expect(await where(page)).toEqual({ path: "/tree/", view: "tree", focus: id, from: id });
    await page.goBack({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#person-hero h1")).toHaveText(NAME[id]);
    expect(await where(page)).toEqual({ path: "/person/", id });
  });
}

test("a different person: tap a parent in the big tree, then cards centred on the parent, then the tree link names the parent", async ({ page }) => {
  const id = CASES.full;
  await page.setViewportSize({ width: 375, height: 1000 });
  await stub(page);
  await page.goto(`/tree/?view=tree&focus=${id}&from=${id}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator('.hfy-bt [aria-current="true"]')).toBeVisible();
  const dad = page.locator('.hfy-bt__canvas button[aria-label$=", father"]');
  const label = await dad.getAttribute("aria-label");
  const dadName = label.replace(/, father$/, "");
  const dadId = await dad.getAttribute("data-k");
  await dad.click();
  await expect(page.locator('.hfy-bt [aria-current="true"]')).toHaveAttribute("aria-label", `${dadName}, in the middle now`);
  expect(await where(page)).toEqual({ path: "/tree/", view: "tree", focus: dadId, from: id });
  await page.locator(".hfy-bt__bar").getByRole("link", { name: "cards", exact: true }).click();
  await expect(page.locator("#hfy-tree-focus-name")).toHaveText(dadName);
  expect(await where(page)).toEqual({ path: "/tree/", view: "cards", focus: dadId });
  await expect(page.getByRole("link", { name: `see ${dadName.split(" ")[0]} in the tree` })).toHaveAttribute("href", `/tree/?view=tree&focus=${dadId}&from=${dadId}`);
  // Back from the cards returns to the big tree on the parent, and once more to the stack's first entry.
  await page.goBack({ waitUntil: "domcontentloaded" });
  await expect(page.locator('.hfy-bt [aria-current="true"]')).toHaveAttribute("aria-label", `${dadName}, in the middle now`);
  expect((await where(page)).focus).toBe(dadId);
});

test("with the flag off the same addresses read as they always did: no tree on the person page, ?view=tree is the cards", async ({ page }) => {
  const id = CASES.full;
  await page.setViewportSize({ width: 375, height: 1000 });
  await stub(page, { familyVizHourglass: false });
  await page.goto(`/person/?id=${id}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#person-hero h1")).toHaveText(NAME[id]);
  await expect(page.locator(".hfy-hg, .hfy-bt")).toHaveCount(0);
  await page.goto(`/tree/?view=tree&focus=${id}&from=${id}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-tree-focus]")).toBeVisible();
  await expect(page.locator(".hfy-bt, [data-tree-ctx], [data-tree-seetree]")).toHaveCount(0);
});
