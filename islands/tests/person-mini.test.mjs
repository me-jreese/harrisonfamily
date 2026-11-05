// HFY-TSK-289: the mini focus view's pure model and DOM (synthetic data only).
import test from "node:test";
import assert from "node:assert/strict";
import { parseGraph } from "../src/lib/family-graph.js";
import { MINI_MAX, miniModel } from "../src/lib/person-mini.js";

const graph = parseGraph({
  schemaVersion: 1,
  people: [
    { id: "I1", name: "Focus Example", birthYear: 1950 }, { id: "I2", name: "Parent Example", birthYear: 1925 },
    { id: "I3", name: "Partner Example", birthYear: 1952 }, ...Array.from({ length: 8 }, (_, i) => ({ id: `I1${i}`, name: `Child ${i}`, birthYear: 1975 + i }))
  ],
  unions: [
    { id: "F1", partners: ["I2"], children: [{ id: "I1", rel: {} }] },
    { id: "F2", partners: ["I1", "I3"], children: Array.from({ length: 8 }, (_, i) => ({ id: `I1${i}`, rel: {} })) }
  ]
});

test("miniModel groups parents, partners and children, caps each group and counts the rest", () => {
  const m = miniModel(graph, "I1");
  assert.equal(m.focus.name, "Focus Example");
  assert.deepEqual(m.groups.map((g) => g.key), ["parents", "partners", "children"]);
  const kids = m.groups[2];
  assert.equal(kids.shown.length, MINI_MAX);
  assert.equal(kids.more, 2);
});

test("miniModel drops empty groups and returns null for an unknown person", () => {
  assert.deepEqual(miniModel(graph, "I3").groups.map((g) => g.key), ["partners", "children"]);
  assert.equal(miniModel(graph, "I404"), null);
});
