// HFY-TSK-272 (viz-v2-bigtree): lib/bigtree-model.js on the synthetic fixtures/tree-graph-poster.json (invented names): the layout block read as a
// poster, a pedigree-collapsed person once with the "also your ancestor through" badge from relationPaths, the 16 px name rule, and no layout.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MIN_NAME_PX, NAME_UNITS, badgeSentence, collapseRoutes, elbowPath, layoutOf, nameLines, posterModel, showsName } from "../src/lib/bigtree-model.js";
import { parseGraph } from "../src/lib/family-graph.js";

const RAW = JSON.parse(readFileSync(new URL("./fixtures/tree-graph-poster.json", import.meta.url), "utf8"));
const load = (edit) => { const d = structuredClone(RAW); edit?.(d); return parseGraph(d); };
const VIEWER = "I9209";

test("layoutOf: the block is read; absent or malformed reads as no layout", () => {
  const l = layoutOf(load());
  assert.equal(l.components.length, 2);
  assert.deepEqual(l.nodeSize, [180, 90]);
  assert.equal(layoutOf(load((d) => delete d.layout)), null);
  assert.equal(layoutOf(load((d) => { d.layout = { components: [] }; })), null);
  assert.equal(layoutOf(load((d) => { d.layout = "nope"; })), null);
  assert.equal(layoutOf(load((d) => { d.layout.components[0].width = "wide"; })), null);
  assert.equal(posterModel(load((d) => delete d.layout), VIEWER), null);
});

test("posterModel: every laid out person once, unions as connectors, one elbow per partner and child link, the singleton not shown", () => {
  const m = posterModel(load(), VIEWER);
  const ids = m.components.flatMap((c) => c.people.map((p) => p.id));
  assert.equal(ids.length, 12);
  assert.equal(new Set(ids).size, 12);
  assert.equal(m.notShown, 1);
  assert.equal(m.components[0].unions.length, 4);
  // 4 unions: 2+2 partner links and 2+1+1+1 child links in the first group
  assert.equal(m.components[0].links.length, 13);
  assert.equal(m.components[1].links.length, 3);
  for (const l of m.components.flatMap((c) => c.links)) assert.match(l.d, /^M-?\d+ -?\d+( [VH]-?\d+)+$/);
  assert.deepEqual(m.card, [160, 70]);
  const cards = new Map(m.components[0].people.map((p) => [p.id, p]));
  assert.deepEqual([cards.get("I9209").x, cards.get("I9209").y], [540, 585]);
});

test("a link with bend points follows them (the bend becomes a waypoint of the elbow)", () => {
  const m = posterModel(load(), VIEWER);
  const l = m.components[0].links.find((x) => x.key === "F9201>I9204");
  assert.ok(l.d.includes("H810"), l.d);
  assert.equal(elbowPath([[0, 0], [0, 50]]), "M0 0 V50");
  assert.equal(elbowPath([[0, 0], [100, 100]]), "M0 0 V50 H100 V100");
  assert.equal(elbowPath([[0, 0], [100, 100], [100, 200]]), "M0 0 V50 H100 V100 V200");
});

test("pedigree collapse: the shared ancestors appear once, each with the badge; everyone else has none", () => {
  const m = posterModel(load(), VIEWER);
  const all = m.components.flatMap((c) => c.people);
  assert.equal(all.filter((p) => p.id === "I9201").length, 1);
  const badged = all.filter((p) => p.badge).map((p) => p.id).sort();
  assert.deepEqual(badged, ["I9201", "I9202"]);
  const una = all.find((p) => p.id === "I9201");
  assert.match(una.badge, /^also your ancestor through (Zed Fenn|Abe Marsh)$/);
  assert.match(una.label, /^Una Fenn, 1900 to 1970, also your ancestor through /);
  // the badge names the route that is not the first one
  assert.equal(collapseRoutes(load(), VIEWER, "I9201").length, 1);
  assert.equal(badgeSentence(load(), [{ through: "I9208" }]), "also your ancestor through Abe Marsh");
});

test("no viewer, or a viewer who is not in the graph, means no badge", () => {
  for (const v of [null, "I0000"]) assert.equal(posterModel(load(), v).components.flatMap((c) => c.people).filter((p) => p.badge).length, 0);
  assert.deepEqual(collapseRoutes(load(), VIEWER, VIEWER), []);
  assert.deepEqual(collapseRoutes(load(), VIEWER, "I9203"), []);
});

test("names are never drawn below 16 px: showsName is the one rule", () => {
  assert.equal(MIN_NAME_PX, 16);
  assert.ok(NAME_UNITS >= MIN_NAME_PX);
  assert.equal(showsName(1), true);
  assert.equal(showsName(1.5), true);
  assert.equal(showsName(0.99), false);
  assert.equal(showsName(0.5), false);
  assert.equal(showsName(NaN), false);
  assert.equal(showsName(0), false);
});

test("nameLines: at most two lines, the second ellipsised; an empty name is one empty line", () => {
  assert.deepEqual(nameLines("Una Fenn"), ["Una Fenn"]);
  assert.deepEqual(nameLines("Bartholomew Wilhelmina Fenn"), ["Bartholomew", "Wilhelmina Fenn"]);
  const long = nameLines("Maximiliano Alessandro Bartholomew Fenn-Marsh");
  assert.equal(long.length, 2);
  assert.ok(long.every((l) => [...l].length <= 16));
  assert.match(long[1], /…$/);
  assert.deepEqual(nameLines(""), [""]);
});
