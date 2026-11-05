// HFY-TSK-271 (viz-v2-faces): "pictured with" chips in the details (familyVizFaces). Hermetic: /_data/flags.json, /auth/* and /person/graph.json are
// route-stubbed with the synthetic tests/fixtures/tree-graph-small.json (invented names) plus a synthetic photoEdges block.
//   HFY_SITE=<dir> PW_PORT=<port> PW_CHANNEL=chromium-headless-shell npx playwright test tests/tree-faces.spec.mjs --workers=1
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axeViolations } from "./axe.mjs";

const SMALL = JSON.parse(readFileSync(new URL("./fixtures/tree-graph-small.json", import.meta.url), "utf8"));
const EDGES = [
  { media: "O1", people: ["I9003", "I9004", "I9002"] },
  { media: "O2", people: ["I9003", "I9004"] },
  { media: "O3", people: ["I9003", "I9999"] } // I9999 is not in the published graph: no chip
];

async function open(page, { width = 1280, faces = true, edges = EDGES, focus = "I9003" } = {}) {
  const graph = JSON.stringify(edges ? { ...SMALL, photoEdges: edges } : SMALL);
  await page.route(/accounts\.google\.com|googleapis|gstatic/, (r) => r.abort());
  await page.route("**/_data/flags.json", (r) => r.fulfill({ json: { authV2: true, shellV2: false, familyViz: true, familyVizFaces: faces } }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { authenticated: true, sub: "I9003", label: "Ada Example" } }));
  await page.route("**/person/graph.json", (r) => r.fulfill({ status: 200, contentType: "application/json", body: graph }));
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width, height: width < 600 ? 812 : 1100 });
  await page.goto(`/tree/?focus=${focus}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-tree-focus]")).toBeVisible();
  return errors;
}

test("flag on, 1280: the panel lists a chip for each person sharing a photo, and a chip re-centres", async ({ page }) => {
  const errors = await open(page);
  const panel = page.locator("[data-tree-panel='I9003']");
  const pictured = panel.locator("[data-tree-pictured]");
  await expect(pictured.getByRole("heading", { name: "pictured with" })).toBeVisible();
  await expect(pictured.locator("button[data-pictured]")).toHaveText(["Bram Example", "Hana Sample"]);
  expect(await axeViolations(page, { include: "[data-tree-panel]" })).toEqual([]);
  const tap = await pictured.locator("button[data-pictured='I9004']").boundingBox();
  expect(tap.height).toBeGreaterThanOrEqual(44);
  await pictured.locator("button[data-pictured='I9004']").click();
  await expect(page.locator("[data-tree-focus] h2")).toHaveText("Bram Example");
  await expect(page.locator("[data-tree-panel='I9004']")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("focus")).toBe("I9004");
  // Bram shares O1 with Ada and Hana, and O2 with Ada: Ada first (2 photos), then Hana (1)
  await expect(page.locator("[data-tree-panel='I9004'] button[data-pictured]")).toHaveText(["Ada Example", "Hana Sample"]);
  expect(errors).toEqual([]);
});

test("flag on, 375: the details sheet has the chips, and a chip closes it and re-centres", async ({ page }) => {
  await open(page, { width: 375 });
  await page.locator("family-navigator .hfy-nav__card--focus").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("button[data-pictured]")).toHaveText(["Bram Example", "Hana Sample"]);
  await dialog.locator("button[data-pictured='I9002']").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("[data-tree-focus] h2")).toHaveText("Hana Sample");
});

test("flag off: no chips section anywhere", async ({ page }) => {
  await open(page, { faces: false });
  await expect(page.locator("[data-tree-panel='I9003']")).toBeVisible();
  await expect(page.locator("[data-tree-pictured]")).toHaveCount(0);
});

test("a graph without photoEdges renders no chips section and no error", async ({ page }) => {
  const errors = await open(page, { edges: null });
  await expect(page.locator("[data-tree-panel='I9003']")).toBeVisible();
  await expect(page.locator("[data-tree-pictured]")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a person whose only shared photo is with someone not in the graph shows no chip", async ({ page }) => {
  await open(page, { edges: [{ media: "O3", people: ["I9003", "I9999"] }] });
  await expect(page.locator("[data-tree-panel='I9003']")).toBeVisible();
  await expect(page.locator("[data-tree-pictured]")).toHaveCount(0);
});
