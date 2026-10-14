// HFY-TSK-201: lib/family-graph.js on a synthetic graph (fixtures/tree-graph-small.json, invented names): parseGraph, the FamilyGraph queries,
// relationLabel, defaultFocus. node --test; no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FamilyGraph, GraphError, parseGraph, relationLabel } from "../src/lib/family-graph.js";

const RAW = readFileSync(new URL("./fixtures/tree-graph-small.json", import.meta.url), "utf8");
const g = parseGraph(RAW);
const ids = (xs) => xs.map((x) => x.id).sort();

test("parseGraph accepts a string or an object and returns a FamilyGraph", () => {
  assert.ok(g instanceof FamilyGraph);
  assert.equal(g.size, 11);
  assert.ok(parseGraph(JSON.parse(RAW)) instanceof FamilyGraph);
  assert.equal(parseGraph({ ...JSON.parse(RAW), minor: 7, extra: true }).meta.minor, 7, "any minor and unknown keys are accepted");
});

test("parseGraph rejects a bad body with GRAPH_PARSE and a bad version with GRAPH_SCHEMA_UNSUPPORTED", () => {
  const code = (input) => { try { parseGraph(input); } catch (e) { assert.ok(e instanceof GraphError); return e.code; } return null; };
  assert.equal(code("{nope"), "GRAPH_PARSE");
  assert.equal(code("[]"), "GRAPH_PARSE");
  assert.equal(code(null), "GRAPH_PARSE");
  assert.equal(code({ schemaVersion: 1, people: {}, unions: [] }), "GRAPH_PARSE");
  assert.equal(code({ schemaVersion: 1, people: [{ id: "a", name: "A" }, { id: "a", name: "B" }], unions: [] }), "GRAPH_PARSE");
  assert.equal(code({ schemaVersion: 1, people: [], unions: [{ id: "u", partners: ["a", "b", "c"] }] }), "GRAPH_PARSE");
  assert.equal(code({ schemaVersion: 2, people: [], unions: [] }), "GRAPH_SCHEMA_UNSUPPORTED");
  assert.equal(code({ people: [], unions: [] }), "GRAPH_SCHEMA_UNSUPPORTED");
});

test("person, parents (with rel), partners, children", () => {
  assert.equal(g.person("I9007").name, "Dina Other");
  assert.equal(g.person("nope"), null);
  assert.deepEqual(g.parents("I9008").sort((a, b) => a.id.localeCompare(b.id)), [{ id: "I9003", rel: "birth" }, { id: "I9005", rel: "adopted" }]);
  assert.deepEqual(g.parents("I9001"), []);
  assert.deepEqual(g.parents("I9010"), [{ id: "I9003", rel: "birth" }], "a one-parent union");
  assert.deepEqual(ids(g.partners("I9003")), ["I9005"]);
  assert.deepEqual(ids(g.children("I9003")), ["I9007", "I9008", "I9010"], "children across both of Ada's unions");
});

test("unionsOf: one entry per union, partner null for a one-parent union, rel keyed by this parent", () => {
  const u = g.unionsOf("I9003");
  assert.deepEqual(u.map((x) => [x.union.id, x.partner]), [["F9002", "I9005"], ["F9004", null]]);
  assert.deepEqual(g.unionsOf("I9005")[0].children, [{ id: "I9007", rel: "birth" }, { id: "I9008", rel: "adopted" }]);
  assert.deepEqual(g.unionsOf("I9011"), []);
});

test("siblings: full within a union; plain when a parent is unrecorded; half only with two recorded parents each sharing one", () => {
  assert.deepEqual(g.siblings("I9003"), [{ id: "I9004", half: false }]);
  assert.deepEqual(g.siblings("I9007").sort((a, b) => a.id.localeCompare(b.id)), [{ id: "I9008", half: false }, { id: "I9010", half: false }]);
  assert.deepEqual(g.siblings("I9011"), []);
});

test("grandparents carry the parent in between; relativeGeneration is other minus person", () => {
  assert.deepEqual(g.grandparents("I9007").sort((a, b) => a.id.localeCompare(b.id)), [{ id: "I9001", via: "I9003" }, { id: "I9002", via: "I9003" }]);
  assert.equal(g.relativeGeneration("I9007", "I9001"), -2);
  assert.equal(g.relativeGeneration("I9001", "I9007"), 2);
  assert.equal(g.relativeGeneration("I9001", "I9011"), null, "other component");
  assert.equal(g.relativeGeneration("I9011", "I9011"), null, "no generation");
  assert.equal(g.relativeGeneration("I9001", "nope"), null);
});

test("neighborhood: ancestors up, descendants down, partners of everyone, parent edges among them", () => {
  const n = g.neighborhood("I9007", { up: 1, down: 0 });
  assert.deepEqual(n.nodes.sort(), ["I9003", "I9005", "I9007"]);
  assert.deepEqual(n.edges.filter((e) => e.kind === "parent").map((e) => `${e.s}>${e.t}`).sort(), ["I9003>I9007", "I9005>I9007"]);
  assert.ok(n.edges.some((e) => e.kind === "partner" && e.union === "F9002"));
  const wide = g.neighborhood("I9003", { up: 2, down: 2 });
  assert.deepEqual(wide.nodes.sort(), ["I9001", "I9002", "I9003", "I9005", "I9007", "I9008", "I9010"]);
  assert.deepEqual(g.neighborhood("nope"), { nodes: [], edges: [] });
});

test("levels per component, unconnected people, descendants and the default focus", () => {
  assert.deepEqual(g.levels(0)[0], ["I9001", "I9002"]);
  assert.deepEqual(g.levels(9), []);
  assert.deepEqual(g.unconnected().map((p) => p.id), ["I9011"]);
  assert.equal(g.descendantCount("I9001"), 6);
  assert.equal(g.descendantCount("I9011"), 0);
  assert.equal(g.defaultFocus(), "I9001", "first of the oldest level with the most descendants");
  assert.equal(parseGraph({ schemaVersion: 1, people: [], unions: [] }).defaultFocus(), null);
});

test("descendantCount terminates on a cycle in the data", () => {
  const cyc = parseGraph({ schemaVersion: 1, people: [{ id: "a", name: "A" }, { id: "b", name: "B" }], unions: [{ id: "u1", partners: ["a"], children: [{ id: "b" }] }, { id: "u2", partners: ["b"], children: [{ id: "a" }] }] });
  assert.equal(cyc.descendantCount("a"), 1);
});

test("dangling references are skipped, never thrown", () => {
  const d = parseGraph({ schemaVersion: 1, people: [{ id: "a", name: "A" }], unions: [{ id: "u", partners: ["a", "ghost"], children: [{ id: "ghost2" }, { id: "a" }] }] });
  assert.deepEqual(d.partners("a"), []);
  assert.deepEqual(d.children("a"), [{ id: "a", rel: "unknown" }]);
  assert.deepEqual(d.parents("a"), [{ id: "a", rel: "unknown" }]);
});

test("relationLabel: direct kin, in-laws of the tree's shape, and null for the rest", () => {
  const L = (v, o) => relationLabel(g, v, o);
  assert.equal(L("I9007", "I9007"), "you");
  assert.equal(L("I9007", "I9003"), "mother");
  assert.equal(L("I9007", "I9005"), "father");
  assert.equal(L("I9003", "I9007"), "daughter");
  assert.equal(L("I9003", "I9010"), "son");
  assert.equal(L("I9007", "I9008"), "brother");
  assert.equal(L("I9007", "I9010"), "brother", "I9010 has one recorded parent, so half cannot be told");
  assert.equal(L("I9003", "I9005"), "husband");
  assert.equal(L("I9005", "I9003"), "wife");
  assert.equal(L("I9007", "I9001"), "grandfather");
  assert.equal(L("I9001", "I9007"), "granddaughter");
  assert.equal(L("I9007", "I9004"), "uncle");
  assert.equal(L("I9009", "I9003"), "aunt");
  assert.equal(L("I9004", "I9007"), "niece");
  assert.equal(L("I9007", "I9009"), "first cousin");
  assert.equal(L("I9007", "I9011"), "not yet connected");
  assert.equal(L("I9007", "nope"), null);
  assert.equal(L("I9001", "I9006"), "daughter-in-law");
});

test("half siblings need two recorded parents each and exactly one shared; cousin is not a sibling", () => {
  const P = (id) => ({ id, name: id });
  const h = parseGraph({ schemaVersion: 1, people: ["a", "b", "c", "d", "x", "y"].map(P), unions: [
    { id: "u1", partners: ["a", "b"], children: [{ id: "x", rel: "birth" }] },
    { id: "u2", partners: ["a", "c"], children: [{ id: "y", rel: "birth" }] }
  ] });
  assert.deepEqual(h.siblings("x"), [{ id: "y", half: true }]);
  assert.equal(relationLabel(h, "x", "y"), "half-sibling");
  assert.equal(relationLabel(h, "x", "d"), "not yet connected", "unrelated pair in a bare graph");
});
