// HFY-TSK-307 (viz-v2-kinship-ui): the "how are we related?" model (lib/kinship-model.js) on the synthetic tests/fixtures/tree-graph-kinship.json
// (invented names). node --test; no browser. The panel itself is tests/tree-kinship.spec.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseGraph } from "../src/lib/family-graph.js";
import { COPY, COUSIN_CAP, ROUTE_CAP, cousinsOf, grandparentsOf, kinshipModel } from "../src/lib/kinship-model.js";

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

// Small synthetic graphs for the branches the shared fixture does not reach (invented ids, no real people).
const person = (id, sex) => ({ id, name: `Person ${id}`, given: id, surname: "Synth", sex, living: false, birthYear: 1900, deathYear: null, yearApprox: false, birthPlace: null, deathPlace: null, generation: 0, component: 0, face: null });
const build = (people, unions) => parseGraph(JSON.stringify({
  schemaVersion: 1, minor: 0, generatedAt: "2026-01-01T00:00:00Z",
  people: people.map(([id, sex]) => person(id, sex)),
  unions: unions.map(([id, partners, kids]) => ({ id, type: "married", partners, children: kids.map((k) => ({ id: k, rel: Object.fromEntries(partners.map((q) => [q, "birth"])) })) })),
  edges: [], generations: []
}));

test("a partner, a partner's parent and a step-sibling carry the 'partner' and \"parent's partner\" tags", () => {
  const sg = build(
    [["V", "m"], ["W", "f"], ["WP", "f"], ["WQ", "m"], ["A", "m"], ["PM", "f"], ["B", "m"], ["D", "f"], ["C", "f"]],
    [["u1", ["V", "W"], []], ["u2", ["WP", "WQ"], ["W"]], ["u3", ["A", "PM"], ["V"]], ["u4", ["PM", "B"], []], ["u5", ["B", "D"], ["C"]]]
  );
  const wife = kinshipModel(sg, "V", "W");
  assert.equal(wife.phrase, "is your wife.");
  assert.equal(wife.routes[0].steps[1].tag, COPY.partner);
  assert.equal(wife.routes[0].steps[1].cards[0].label, "wife, partner");
  const inLaw = kinshipModel(sg, "V", "WP");
  assert.equal(inLaw.phrase, "is your mother-in-law.");
  assert.deepEqual(inLaw.routes[0].steps.map((s) => s.tag), [COPY.you, COPY.partner, COPY.ancestor]);
  const step = kinshipModel(sg, "V", "C");
  assert.equal(step.phrase, "is your stepsister.");
  assert.deepEqual(step.routes[0].steps.map((s) => s.tag), [COPY.you, "", COPY.stepParent, ""]);
});

test("a person joined only by a long chain of marriages reads 'related by marriage'", () => {
  const sg = build(
    [["V", "m"], ["W", "f"], ["WP", "f"], ["WQ", "m"], ["WS", "f"], ["WX", "m"]],
    [["u1", ["V", "W"], []], ["u2", ["WP", "WQ"], ["W", "WS"]], ["u3", ["WS", "WX"], []]]
  );
  const m = kinshipModel(sg, "V", "WX");
  assert.equal(m.state, "marriage");
  assert.equal(m.phrase, COPY.marriage);
  assert.deepEqual(m.routes, []);
});

test("more routes than ROUTE_CAP: the sentence counts them all and the model says how many were left out", () => {
  const people = [["A", "m"], ["B", "f"], ["V", "m"], ["X", "f"], ["P1", "m"], ["P2", "f"], ["Q1", "m"], ["Q2", "f"], ["G1", "m"], ["G2", "f"], ["G3", "m"], ["G4", "f"], ["H1", "m"], ["H2", "f"], ["H3", "m"], ["H4", "f"]];
  const sg = build(people, [
    ["a", ["A", "B"], ["G1", "G2", "G3", "G4", "H1", "H2", "H3", "H4"]],
    ["p", ["G1", "G2"], ["P1"]], ["p2", ["G3", "G4"], ["P2"]], ["q", ["H1", "H2"], ["Q1"]], ["q2", ["H3", "H4"], ["Q2"]],
    ["b", ["P1", "P2"], ["V"]], ["c", ["Q1", "Q2"], ["X"]]
  ]);
  const m = kinshipModel(sg, "V", "X");
  assert.equal(m.routes.length, ROUTE_CAP);
  assert.ok(m.hidden > 0);
  assert.equal(m.hidden + m.routes.length, 16);
  assert.match(m.phrase, /through 16 different routes\.$/);
  assert.match(COPY.moreRoutes(m.hidden), /^\d+ more routes not shown\.$/);
  assert.equal(kinshipModel(g, "K1000", "K1020").hidden, 0);
});

test("the pill's load-failed line is the model's", () => {
  const src = readFileSync(new URL("../src/islands/tree.jsx", import.meta.url), "utf8");
  assert.ok(src.includes(`"${COPY.loadFailed}"`));
});
