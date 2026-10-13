// viz-generation-index: computeGenerations (viz.md 5.4) on hand-built synthetic fixtures, each with its expected levels, plus the
// 2,000-person timing budget (viz.md section 11: at most 200 ms on Node 22).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeGenerations } from '../src/generations.mjs';
import { buildFamilyGraph } from '../src/build.mjs';
import { messyTree } from './fixtures/gramps.mjs';
import { NOW } from './helpers.mjs';

const person = (id, birthYear = null) => ({ id, birthYear });
const union = (partners, children = []) => ({ partners, children: children.map((id) => ({ id })) });
/** {component -> levels} plus the per-person generation, for compact assertions. */
function run(people, unions) {
  const r = computeGenerations(people, unions);
  return { ...r, levels: r.generations.map((g) => g.levels), gen: Object.fromEntries(r.generation) };
}

describe('computeGenerations', () => {
  it('pedigree collapse: cousins who marry put their child one level down, once', () => {
    const people = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].map((id) => person(id));
    const unions = [
      union(['A', 'B'], ['C', 'D']),
      union(['C', 'E'], ['F']), // E married in
      union(['D', 'G'], ['H']), // G married in
      union(['F', 'H'], ['I']), // first cousins
    ];
    const r = run(people, unions);
    assert.deepEqual(r.levels, [[['A', 'B'], ['C', 'D', 'E', 'G'], ['F', 'H'], ['I']]]);
    assert.deepEqual(r.cycle, []);
    assert.equal(r.generations[0].levels.flat().filter((id) => id === 'I').length, 1);
  });

  it('cross-generation marriage: two partners with parents keep their own levels, unflagged', () => {
    const people = [person('P'), person('Q'), person('R'), person('S'), person('T'), person('U'), person('K')];
    const unions = [
      union(['P', 'Q'], ['R', 'S']),
      union(['R', 'T'], ['U']), // T married in
      union(['S', 'U'], ['K']), // aunt and nephew: levels 1 and 2
    ];
    const r = run(people, unions);
    assert.deepEqual(r.levels, [[['P', 'Q'], ['R', 'S', 'T'], ['U'], ['K']]]);
    assert.equal(r.gen.S, 1);
    assert.equal(r.gen.U, 2);
    assert.equal(r.gen.K, 3);
    assert.deepEqual(r.cycle, []);
  });

  it('a cycle: its members and everything below them get null and are reported; the rest is placed', () => {
    const people = ['A', 'B', 'C', 'D', 'X'].map((id) => person(id));
    const unions = [
      union(['D'], ['A']),
      union(['A'], ['B']),
      union(['B'], ['A', 'C']), // A -> B -> A
      union(['X'], []), // unrelated singleton-ish union
    ];
    const r = run(people, unions);
    assert.deepEqual(r.cycle, ['A', 'B', 'C']);
    assert.deepEqual(r.gen, { A: null, B: null, C: null, D: 0, X: 0 });
    assert.deepEqual(r.levels, [[['D']], [['X']]]);
  });

  it('a component made only of a cycle has no levels, and a self-parent never hangs', () => {
    const r = run([person('A'), person('B')], [union(['A'], ['B']), union(['B'], ['A']), union(['B'], ['B'])]);
    assert.deepEqual(r.cycle, ['A', 'B']);
    assert.deepEqual(r.levels, [[]]);
  });

  it('singletons are their own components at generation 0', () => {
    const r = run([person('I3'), person('I1', 1950), person('I2', 1900)], []);
    assert.deepEqual(r.components.map((c) => c.roots), [['I1'], ['I2'], ['I3']]);
    assert.deepEqual(r.levels, [[['I1']], [['I2']], [['I3']]]);
    assert.deepEqual(r.gen, { I1: 0, I2: 0, I3: 0 });
  });

  it('two partner families: a parentless partner takes the highest level among its partners', () => {
    const people = ['P1', 'P2', 'N2', 'M', 'N1', 'c1', 'c2'].map((id) => person(id));
    const unions = [
      union(['P1', 'P2'], ['N2']),
      union(['M', 'N1'], ['c1']), // M and N1 both have no parents
      union(['M', 'N2'], ['c2']), // N2 has parents, so M (and then N1) move to level 1
    ];
    const r = run(people, unions);
    assert.deepEqual(r.levels, [[['P1', 'P2'], ['M', 'N1', 'N2'], ['c1', 'c2']]]);
  });

  it('alignment re-propagates descendants and terminates on a contradictory union', () => {
    // X is a partner of Y and also Y's parent: alignment alone would rise forever; the round cap stops it
    const r = run([person('X'), person('Y'), person('Z')], [union(['X'], ['Y']), union(['X', 'Y'], ['Z'])]);
    assert.deepEqual(r.cycle, []);
    assert.ok(Number.isInteger(r.gen.X) && Number.isInteger(r.gen.Y) && Number.isInteger(r.gen.Z));
    assert.ok(r.gen.Y > r.gen.X - 1 && r.gen.Z > r.gen.Y);
  });

  it('parentless siblings, single-parent unions and step children each sit one level below their parents', () => {
    const people = ['A', 'B', 'C', 'S1', 'S2'].map((id) => person(id));
    const unions = [union([], ['S1', 'S2']), union(['A'], ['B']), union(['B', 'C'], [])];
    const r = run(people, unions);
    assert.deepEqual(r.levels, [[['A'], ['B', 'C']], [['S1', 'S2']]]);
  });

  it('levels are ordered by (birthYear ?? 9999, id) and each component starts at 0', () => {
    const people = [person('B', 1900), person('A', 1905), person('C', null), person('K1', 1930), person('K2', 1925)];
    const r = run(people, [union(['A', 'B'], ['K1', 'K2']), union(['C', 'K1'], [])]);
    assert.deepEqual(r.levels, [[['B', 'A'], ['K2', 'K1', 'C']]]);
  });

  it('is deterministic: shuffled people and unions give the same result', () => {
    const people = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].map((id, i) => person(id, 1900 + (i % 3)));
    const unions = [union(['A', 'B'], ['C', 'D']), union(['C', 'E'], ['F']), union(['D', 'G'], ['H']), union(['F', 'H'], ['I'])];
    const a = computeGenerations(people, unions);
    const b = computeGenerations([...people].reverse(), [...unions].reverse().map((u) => ({ ...u, partners: [...u.partners].reverse() })));
    assert.deepEqual(b.generations, a.generations);
    assert.deepEqual([...b.generation].sort(), [...a.generation].sort());
    assert.deepEqual(b.components, a.components);
  });

  it('refs to people outside the list are ignored', () => {
    const r = run([person('A'), person('B')], [union(['A', 'GHOST'], ['B', 'NOBODY'])]);
    assert.deepEqual(r.levels, [[['A'], ['B']]]);
  });
});

describe('the build fills generation and generations, and reports GRAPH_CYCLE locally', () => {
  it('the messy fixture: three levels in component 0, everyone placed', () => {
    const { graph, report } = buildFamilyGraph(messyTree().list(), { now: NOW });
    assert.equal(graph.generations.length, graph.components.length);
    assert.deepEqual(graph.generations[0].levels.map((l) => l.length), [3, 7, 1]);
    assert.ok(graph.people.every((p) => Number.isInteger(p.generation)));
    assert.ok(!report.warnings.some((w) => w.code === 'GRAPH_CYCLE'));
  });
});

/** A synthetic tree of `n` people: 8 generations of couples, a married-in partner for every child who marries, seeded. */
function syntheticTree(n) {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const people = [];
  const unions = [];
  const id = () => {
    const v = `I${String(people.length + 1).padStart(5, '0')}`;
    people.push(person(v, 1700 + Math.floor(rand() * 300)));
    return v;
  };
  let couples = [[id(), id()]];
  while (people.length < n) {
    const next = [];
    for (const [a, b] of couples) {
      const kids = [];
      const k = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < k && people.length < n; i++) kids.push(id());
      unions.push(union([a, b], kids));
      for (const kid of kids) if (people.length < n && rand() < 0.6) next.push([kid, id()]);
    }
    if (!next.length) break;
    couples = next;
  }
  while (people.length < n) id(); // singletons for the rest
  return { people, unions };
}

describe('performance', () => {
  it('a synthetic 2,000-person graph computes in at most 200 ms', () => {
    const { people, unions } = syntheticTree(2000);
    assert.equal(people.length, 2000);
    computeGenerations(people, unions); // warm-up
    const t0 = performance.now();
    const r = computeGenerations(people, unions);
    const ms = performance.now() - t0;
    assert.ok(ms <= 200, `${ms.toFixed(1)} ms`);
    assert.ok(r.generations[0].levels.length >= 8, `${r.generations[0].levels.length} levels`);
    assert.deepEqual(r.cycle, []);
  });
});
