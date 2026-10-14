// HFY-TSK-202: lib/tree-outline.js (the focus navigator's groups and the generation outline's model) in node, on the synthetic graph.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseGraph } from "../src/lib/family-graph.js";
import { LEVEL_PAGE, focusGroups, generationLabel, outlineModel, roleLabel } from "../src/lib/tree-outline.js";

const g = parseGraph(readFileSync(new URL("./fixtures/tree-graph-small.json", import.meta.url), "utf8"));

test("focusGroups: parents, partners and children per union, siblings, grandparents", () => {
  const a = focusGroups(g, "I9003");
  assert.deepEqual(a.parents.map((p) => [p.id, p.label]), [["I9001", "father"], ["I9002", "mother"]]);
  assert.equal(a.unions.length, 2);
  assert.equal(a.unions[0].title, "partner and children (1 of 2)");
  assert.deepEqual([a.unions[0].partner.id, a.unions[0].partner.label], ["I9005", "husband"]);
  assert.equal(a.unions[0].children.length, 2);
  assert.match(focusGroups(g, "I9005").unions[0].children[1].label, /^adopted /);
  assert.equal(a.unions[1].title, "children (2 of 2)");
  assert.equal(a.unions[1].partner, null);
  assert.deepEqual(a.siblings.map((s) => s.id), ["I9004"]);
  const c = focusGroups(g, "I9007");
  assert.deepEqual(c.grandparents.map((x) => x.id), ["I9001", "I9002"]);
  assert.equal(focusGroups(g, "I9001").parents.length, 0);
});

test("roleLabel: unmarried partners are 'partner'; step and half prefixes", () => {
  assert.equal(roleLabel("partner", { sex: "f" }, { unionType: "married" }), "wife");
  assert.equal(roleLabel("partner", { sex: "u" }, { unionType: "married" }), "spouse");
  assert.equal(roleLabel("partner", { sex: "f" }, { unionType: "unknown" }), "partner");
  assert.equal(roleLabel("sibling", { sex: "m" }, { half: true }), "half-brother");
  assert.equal(roleLabel("parent", { sex: "f" }, { rel: "step" }), "step mother");
});

test("generationLabel: relative to the focus, never absolute", () => {
  assert.equal(generationLabel(0, "Ada"), "Ada's generation");
  assert.equal(generationLabel(-1, "Ada"), "Ada's parents' generation");
  assert.equal(generationLabel(-2, "Ada"), "Ada's grandparents' generation");
  assert.equal(generationLabel(-3, "Ada"), "Ada's great-grandparents' generation");
  assert.equal(generationLabel(1, "Ada"), "Ada's children's generation");
  assert.equal(generationLabel(2, "Ada"), "Ada's grandchildren's generation");
});

test("outlineModel: the focus's component by level, the rest under 'not yet connected'", () => {
  const m = outlineModel(g, "I9003");
  assert.equal(m.levels.length, 3);
  assert.deepEqual(m.levels.map((l) => l.label), ["Ada's parents' generation", "Ada's generation", "Ada's children's generation"]);
  assert.deepEqual(m.levels.map((l) => l.hasFocus), [false, true, false]);
  assert.deepEqual(m.unconnected, ["I9011"]);
  assert.equal(m.relative, true);
});

test("outlineModel: an unconnected focus still gets the main tree, with ordinal labels", () => {
  const m = outlineModel(g, "I9011");
  assert.equal(m.relative, false);
  assert.equal(m.levels.length, 3);
  assert.match(m.levels[0].label, /^generation 1 of 3$/);
  assert.deepEqual(m.unconnected, ["I9011"]);
});

test("outlineModel: every person is listed exactly once", () => {
  const m = outlineModel(g, "I9003");
  const all = [...m.levels.flatMap((l) => l.ids), ...m.unconnected];
  assert.equal(all.length, g.size);
  assert.equal(new Set(all).size, g.size);
  assert.equal(LEVEL_PAGE, 20);
});
