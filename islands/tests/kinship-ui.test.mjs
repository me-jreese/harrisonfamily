// HFY-TSK-307 (viz-v2-kinship-ui): the "how are we related?" model (lib/kinship-model.js) on the synthetic tests/fixtures/tree-graph-kinship.json
// (invented names). node --test; no browser. The panel itself is tests/tree-kinship.spec.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseGraph } from "../src/lib/family-graph.js";
import { COPY, COUSIN_CAP, cousinsOf, grandparentsOf, kinshipModel } from "../src/lib/kinship-model.js";

const g = parseGraph(readFileSync(new URL("./fixtures/tree-graph-kinship.json", import.meta.url), "utf8"));
const names = (route) => route.steps.map((s) => s.cards.map((c) => g.person(c.id).name).join(" + "));

test("a first cousin: one route, viewer to common ancestors (a couple is one step) and down, and one plain sentence", () => {
  const m = kinshipModel(g, "K1000", "K1004");
  assert.equal(m.state, "related");
  assert.equal(m.phrase, "is your first cousin.");
  assert.equal(m.routes.length, 1);
  assert.deepEqual(names(m.routes[0]), ["Robin Mirren", "Lark Mirren", "Hale Mirren + Ione Mirren", "Nell Mirren", "Sorrel Vance"]);
  assert.equal(m.routes[0].steps[2].tag, COPY.ancestor);
  assert.deepEqual(m.routes[0].steps[0].cards[0], { id: "K1000", label: "you" });
  assert.equal(m.routes[0].steps[3].cards[0].label, "aunt");
});

test("pedigree collapse: both routes are listed and the sentence says so", () => {
  const m = kinshipModel(g, "K1000", "K1020");
  assert.equal(m.routes.length, 2);
  assert.match(m.phrase, /through 2 different routes\.$/);
  assert.deepEqual(names(m.routes[0]).slice(-3), ["Nell Mirren", "Sorrel Vance", "Una Vance"]);
  assert.deepEqual(names(m.routes[1]).slice(-3), ["Orin Mirren", "Tarn Quill", "Una Vance"]);
});

test("self, no connection and a missing id each give their own state", () => {
  assert.equal(kinshipModel(g, "K1000", "K1000").state, "self");
  const none = kinshipModel(g, "K1000", "K1030");
  assert.equal(none.state, "none");
  assert.equal(none.phrase, COPY.none);
  assert.equal(kinshipModel(g, "K1000", "nope").state, "missing");
  assert.equal(kinshipModel(null, "K1000", "K1004").state, "missing");
});

test("an ancestor: a straight chain, with the person as the common ancestor's step", () => {
  const m = kinshipModel(g, "K1000", "K1011");
  assert.equal(m.phrase, "is your grandfather.");
  assert.equal(m.routes.length, 1);
  assert.deepEqual(names(m.routes[0]), ["Robin Mirren", "Lark Mirren", "Hale Mirren"]);
});

test("the shortcuts: the viewer's grandparents and first cousins, never the viewer, parents or brothers and sisters", () => {
  assert.deepEqual(grandparentsOf(g, "K1000").map((x) => x.id), ["K1011", "K1012", "K1013", "K1014"]);
  assert.deepEqual(cousinsOf(g, "K1000").map((x) => x.id), ["K1004", "K1005"]);
  assert.ok(cousinsOf(g, "K1000").every((x) => x.label === "first cousin"));
  assert.deepEqual(grandparentsOf(g, "K1011"), []);
  assert.deepEqual(cousinsOf(g, "nope"), []);
  assert.ok(COUSIN_CAP >= 1);
});
