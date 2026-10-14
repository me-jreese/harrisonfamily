// HFY-TSK-270: the kinship engine in lib/family-graph.js (relationPaths and the 30-case relationLabel table) on synthetic graphs, invented ids
// only. node --test; no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRelationWord, parseGraph, relationLabel } from "../src/lib/family-graph.js";

// A lineage L0..L5 (L0 is the viewer, L5 the oldest) with a spouse Mk for each Lk (k >= 1) and a sibling Sk-1 of Lk-1 in every union Uk.
function build() {
  const people = [];
  const unions = [];
  const P = (id, sex, extra = {}) => { people.push({ id, name: `Person ${id}`, sex, generation: 0, component: 0, ...extra }); };
  const U = (id, partners, children) => unions.push({ id, type: "married", partners, children: children.map((c) => (typeof c === "string" ? { id: c, rel: Object.fromEntries(partners.map((x) => [x, "birth"])) } : c)) });
  for (let k = 0; k <= 5; k += 1) P(`L${k}`, "m");
  for (let k = 1; k <= 5; k += 1) P(`M${k}`, "f");
  const sexS = ["f", "m", "f", "m"];
  for (let k = 0; k <= 3; k += 1) P(`S${k}`, sexS[k]);
  for (let k = 1; k <= 5; k += 1) U(`U${k}`, [`L${k}`, `M${k}`], k <= 4 ? [`L${k - 1}`, `S${k - 1}`] : [`L${k - 1}`]);
  // half-brother H: a child of L1 and a second partner N
  P("N", "f"); P("H", "m"); U("UH", ["L1", "N"], ["H"]);
  // first cousins: C1 child of S1, then C2..C4 down the line (once, twice, three times removed); Y has two parents who are both children of S1
  P("C1", "f"); P("C2", "m"); P("C3", "f"); P("C4", "m"); P("T", "m"); P("SP", "f"); P("Y", "f");
  U("UC", ["S1", "SP"], ["C1", "T"]); U("UC1", ["C1"], ["C2"]); U("UC2", ["C2"], ["C3"]); U("UC3", ["C3"], ["C4"]);
  U("UY", ["C1", "T"], ["Y"]);
  // second and third cousins, removed
  P("D", "f"); P("E", "m"); U("UD", ["S2"], ["D"]); U("UE", ["D"], ["E"]);
  P("F", "m"); P("G", "f"); P("K", "m"); U("UF", ["S3"], ["F"]); U("UG", ["F"], ["G"]); U("UK", ["G"], ["K"]);
  // in-laws: X is the husband of S0
  P("X", "m"); U("UX", ["S0", "X"], []);
  // adoption: AD is the adopted child of L0 (birth child of Q)
  P("Q", "f"); P("AD", "f"); U("UA", ["L0", "Q"], [{ id: "AD", rel: { L0: "adopted", Q: "birth" } }]);
  // not related: two people in the component with no path; and a lone person in a component of their own
  P("R1", "m"); P("R2", "f");
  people.push({ id: "LONE", name: "Person LONE", sex: "u", generation: 0, component: 7 });
  return parseGraph({ schemaVersion: 1, people, unions });
}
const g = build();

// The 30-case table: [viewer, other, exact label].
const TABLE = [
  ["L0", "L0", "you"],
  ["L0", "L1", "father"],
  ["L0", "M1", "mother"],
  ["L0", "L2", "grandfather"],
  ["L0", "M3", "great-grandmother"],
  ["L0", "L4", "second great-grandfather"],
  ["L0", "M5", "third great-grandmother"],
  ["L1", "L0", "son"],
  ["L2", "L0", "grandson"],
  ["L5", "L0", "third great-grandson"],
  ["L0", "S0", "sister"],
  ["L0", "H", "half-brother"],
  ["L0", "S1", "uncle"],
  ["L0", "S2", "great-aunt"],
  ["L0", "S3", "second great-uncle"],
  ["S1", "L0", "nephew"],
  ["S2", "L0", "great-nephew"],
  ["L0", "C1", "first cousin"],
  ["L0", "E", "second cousin"],
  ["L0", "K", "third cousin"],
  ["L0", "D", "first cousin once removed"],
  ["L0", "G", "second cousin once removed"],
  ["L0", "F", "first cousin twice removed"],
  ["L0", "C4", "first cousin 3 times removed"],
  ["L0", "X", "brother-in-law"],
  ["X", "L1", "father-in-law"],
  ["L0", "N", "stepmother"],
  ["N", "L0", "stepson"],
  ["L2", "M1", "daughter-in-law"],
  ["L0", "AD", "adopted daughter"],
  ["AD", "L0", "adoptive father"],
  ["L0", "R1", "not related"],
  ["L0", "LONE", "not yet connected"],
  ["LONE", "L0", "not yet connected"]
];

test("relationLabel: the kinship table (exact strings)", () => {
  assert.ok(TABLE.length >= 30);
  for (const [v, o, expected] of TABLE) assert.equal(relationLabel(g, v, o), expected, `${v} -> ${o}`);
});

test("relationLabel: labels are lowercase words; an unknown id is null; the focus card words are told apart", () => {
  for (const [v, o] of TABLE) assert.equal(relationLabel(g, v, o), relationLabel(g, v, o).toLowerCase());
  assert.equal(relationLabel(g, "L0", "ghost"), null);
  assert.equal(relationLabel(g, "ghost", "L0"), null);
  assert.equal(isRelationWord("mother"), true);
  for (const w of ["you", "not yet connected", "not related", null]) assert.equal(isRelationWord(w), false);
});

test("relationLabel: a different component is never compared, even for a one-person component", () => {
  assert.equal(relationLabel(g, "L0", "LONE"), "not yet connected");
  assert.equal(g.relationPaths("L0", "LONE").length, 0);
});

test("relationPaths: shortest paths through common ancestors", () => {
  const sib = g.relationPaths("L0", "S0");
  assert.equal(sib.length, 2, "full siblings: one path through each parent");
  assert.deepEqual(sib.map((p) => p.ancestor).sort(), ["L1", "M1"]);
  assert.deepEqual(sib[0].up.length + sib[0].down.length, 4);
  assert.equal(sib[0].length, 2);
  assert.equal(g.relationPaths("L0", "H").length, 1, "half-siblings: one path");
  const anc = g.relationPaths("L0", "L3");
  assert.equal(anc.length, 1);
  assert.deepEqual(anc[0].nodes, ["L0", "L1", "L2", "L3"]);
  assert.deepEqual(anc[0].down, ["L3"]);
  assert.equal(g.relationPaths("L0", "ghost").length, 0);
  assert.equal(g.relationPaths("L0", "R1").length, 0);
});

test("relationPaths: pedigree collapse lists both paths", () => {
  const y = g.relationPaths("L0", "Y");
  assert.equal(y.length, 4, "two grandparents of the viewer, and Y reaches S1 through two parents");
  assert.deepEqual(y.map((p) => p.down.join(">")).sort(), ["L2>S1>C1>Y", "L2>S1>T>Y", "M2>S1>C1>Y", "M2>S1>T>Y"]);
  assert.equal(relationLabel(g, "L0", "Y"), "first cousin once removed");
});

test("relationPaths: a partner hop is used only when it is the shortest way", () => {
  const x = g.relationPaths("L0", "X");
  assert.equal(x[0].kind, "partner");
  assert.equal(x[0].side, "b");
  assert.equal(x[0].nodes.length, 4, "L0, a parent, S0, X");
  assert.equal(x[0].nodes[0], "L0");
  assert.equal(x[0].nodes.at(-1), "X");
  const direct = g.relationPaths("L1", "M1");
  assert.equal(direct[0].kind, "partner");
  assert.equal(direct[0].side, "direct");
});

// A deterministic synthetic graph of 2,000 people over ten generations of 200: each generation is paired into couples, each couple has two
// children in the next generation, and the next generation's couples marry across families, so pedigree collapse is dense.
function big() {
  const gens = 10;
  const width = 200;
  const people = [];
  const unions = [];
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let gen = 0; gen < gens; gen += 1) for (let i = 0; i < width; i += 1) people.push({ id: `p${gen}_${i}`, name: `Person ${gen}-${i}`, sex: i % 2 ? "f" : "m", generation: gen, component: 0 });
  for (let gen = 0; gen + 1 < gens; gen += 1) {
    const order = Array.from({ length: width }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i -= 1) { const j = rnd(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
    for (let c = 0; c < width / 2; c += 1) {
      const a = `p${gen}_${order[2 * c]}`;
      const b = `p${gen}_${order[2 * c + 1]}`;
      const kids = [`p${gen + 1}_${2 * c}`, `p${gen + 1}_${2 * c + 1}`];
      unions.push({ id: `u${gen}_${c}`, type: "married", partners: [a, b], children: kids.map((k) => ({ id: k, rel: { [a]: "birth", [b]: "birth" } })) });
    }
  }
  return parseGraph({ schemaVersion: 1, people, unions });
}

test("relationPaths runs within 50 ms on a synthetic 2,000-person graph", () => {
  const b = big();
  assert.equal(b.size, 2000);
  const pairs = [];
  for (let i = 0; i < 20; i += 1) pairs.push([`p9_${i * 9}`, `p9_${199 - i * 7}`], [`p9_${i}`, `p0_${i * 3}`], [`p9_${i * 5}`, `p7_${i * 2}`]);
  b.relationPaths(pairs[0][0], pairs[0][1]); // warm up
  let worst = 0;
  for (const [x, y] of pairs) {
    const t = performance.now();
    const paths = b.relationPaths(x, y);
    worst = Math.max(worst, performance.now() - t);
    assert.ok(paths.length <= 64);
    assert.ok(typeof relationLabel(b, x, y) === "string");
  }
  assert.ok(worst < 50, `slowest pair took ${worst.toFixed(1)} ms`);
});
