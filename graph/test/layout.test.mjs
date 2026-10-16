// viz-graph-v2-layout: the d3-dag 1.2.2 layout block (ADR 4.7). Synthetic fixtures only (invented names, places and ids).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { graphStratify, sugiyama, layeringSimplex, decrossTwoLayer, coordGreedy } from 'd3-dag';
import { buildFamilyGraph, MINOR } from '../src/build.mjs';
import { computeLayout, ENGINE } from '../src/layout.mjs';
import { stringify } from '../src/canonical.mjs';
import { GraphError } from '../src/errors.mjs';
import { assertVerified, DETECTORS, loadSchema, verifyGraph } from '../src/verify.mjs';
import { validateSchema } from '../src/schema-validate.mjs';
import { shuffled } from './fixtures/gramps.mjs';
import { layoutMessyTree } from './fixtures/layout-messy.mjs';
import { GENERATED_AT, GOLDEN, NOW, run, scratch } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GRAPH_DIR = join(HERE, '..');
const REPO = join(GRAPH_DIR, '..');
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020');

const build = (objects) => buildFamilyGraph(objects, { generatedAt: GENERATED_AT, now: NOW });
const messy = () => build(layoutMessyTree().list());

// ---------------------------------------------------------------------------------------------------------------------
// AC1: the pin, and where its dependencies are allowed to appear

const LOCK_FILES = /(^|[\\/])(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const SKIP_DIRS = new Set(['node_modules', '.git']);

/** Every lockfile and package.json under the repository, by relative path. */
function repoFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const list = out.split('\0').filter(Boolean);
    if (list.length > 0) return list;
  } catch {
    // no git (a tarball checkout): walk the tree instead
  }
  const found = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.isDirectory()) walk(join(dir, e.name));
      else found.push(relative(REPO, join(dir, e.name)).split(sep).join('/'));
    }
  };
  walk(REPO);
  return found;
}

const D3_DAG_FAMILY = ['d3-dag', 'javascript-lp-solver', 'quadprog', 'stringify-object', 'd3-array'];

describe('d3-dag 1.2.2 is a dependency of graph/ only', () => {
  const pkg = JSON.parse(readFileSync(join(GRAPH_DIR, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(GRAPH_DIR, 'package-lock.json'), 'utf8'));

  it('graph/package.json pins it exactly, as a dependency and not a dev dependency', () => {
    assert.equal(pkg.dependencies['d3-dag'], '1.2.2');
    assert.equal(pkg.devDependencies?.['d3-dag'], undefined);
  });

  it('graph/package-lock.json holds d3-dag 1.2.2 and each of its dependencies', () => {
    assert.equal(lock.packages['node_modules/d3-dag'].version, '1.2.2');
    for (const name of D3_DAG_FAMILY) assert.ok(lock.packages[`node_modules/${name}`], `${name} is in graph/package-lock.json`);
    assert.equal(lock.packages['node_modules/javascript-lp-solver'].license, 'Unlicense');
  });

  it('no other lockfile in the repository (islands, the chat worker, api, auth, lambda) holds any of them', () => {
    const lockfiles = repoFiles().filter((f) => LOCK_FILES.test(f) && f !== 'graph/package-lock.json' && !f.startsWith('graph/cloud/'));
    assert.ok(lockfiles.some((f) => f.startsWith('islands/')), 'the islands lockfile is among those checked');
    const hits = [];
    for (const f of lockfiles) {
      const path = join(REPO, f);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      for (const name of D3_DAG_FAMILY) {
        // package-lock keys ("node_modules/<name>"), pnpm keys ("/<name>@" or "<name>@") and yarn keys ("<name>@")
        const re = new RegExp(`(node_modules/|["'/\\s]|^)${name.replace(/[-/]/g, '\\$&')}(@|["'])`, 'm');
        if (re.test(text) || text.includes(`node_modules/${name}"`)) hits.push(`${f}: ${name}`);
      }
    }
    assert.deepEqual(hits, []);
  });

  it('no other package.json in the repository declares d3-dag', () => {
    const hits = repoFiles()
      .filter((f) => f.endsWith('package.json') && f !== 'graph/package.json' && f !== 'graph/cloud/package.json')
      .filter((f) => existsSync(join(REPO, f)) && /"d3-dag"/.test(readFileSync(join(REPO, f), 'utf8')));
    assert.deepEqual(hits, []);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// AC2: the shape of the block

/** Layer index of every node of a component: the rank of its y among the distinct ys. */
function layersOf(c) {
  const ys = [...new Set([...c.people, ...c.unions].map((n) => n.y))].sort((a, b) => a - b);
  return (y) => ys.indexOf(y);
}

describe('the layout block (ADR 4.7)', () => {
  const { graph } = messy();
  const layout = graph.layout;
  const person = new Map(graph.people.map((p) => [p.id, p]));

  it('is stamped d3-dag 1.2.2 with coordGreedy, never coordSimplex, and minor is bumped by one', () => {
    assert.equal(layout.engine, 'd3-dag 1.2.2');
    assert.equal(layout.engine, ENGINE);
    assert.deepEqual(layout.params, { layering: 'simplex+rank', decross: 'twoLayer', coord: 'greedy', nodeSize: [180, 90] });
    assert.equal(MINOR, 3); // main was at 2 (photoEdges)
    assert.equal(graph.minor, 3);
    assert.equal(graph.schemaVersion, 1);
  });

  it('every coordinate, width, height and bend point is an integer', () => {
    const nums = [];
    for (const c of layout.components) {
      nums.push(c.width, c.height);
      for (const n of [...c.people, ...c.unions]) nums.push(n.x, n.y);
      for (const b of c.bends) for (const pt of b.points) nums.push(...pt);
    }
    assert.ok(nums.length > 40);
    assert.ok(nums.every((n) => Number.isInteger(n) && !Object.is(n, -0)));
  });

  it('ranks: a person sits on its generation layer, a union with partners just below the highest partner, a partnerless union just above its first child', () => {
    for (const c of layout.components) {
      const layer = layersOf(c);
      const genLayer = new Map(); // generation -> layer, one per generation
      for (const n of c.people) {
        const g = person.get(n.id).generation;
        if (genLayer.has(g)) assert.equal(layer(n.y), genLayer.get(g), `generation ${g} of component ${c.component} is on one layer`);
        genLayer.set(g, layer(n.y));
      }
      const at = new Map(c.people.map((n) => [n.id, layer(n.y)]));
      for (const n of c.unions) {
        const u = graph.unions.find((x) => x.id === n.id);
        const partners = u.partners.filter((id) => at.has(id));
        const kids = u.children.map((k) => k.id).filter((id) => at.has(id));
        const expected = partners.length
          ? 2 * Math.max(...partners.map((id) => person.get(id).generation)) + 1
          : 2 * Math.min(...kids.map((id) => person.get(id).generation)) - 1;
        // layer(y) counts occupied layers; the occupied ones are person layers (even ranks) and union layers (odd ranks)
        if (partners.length) assert.equal(layer(n.y), at.get(partners.sort((a, b) => person.get(b).generation - person.get(a).generation)[0]) + 1, `union ${n.id} (rank ${expected})`);
        else assert.equal(layer(n.y) + 1, Math.min(...kids.map((id) => at.get(id))), `partnerless union ${n.id} (rank ${expected})`);
      }
    }
  });

  it('bend points exist exactly for links that span more than one layer, one per layer crossed', () => {
    let longLinks = 0;
    for (const c of layout.components) {
      const layer = layersOf(c);
      const at = new Map([...c.people, ...c.unions].map((n) => [n.id, layer(n.y)]));
      const links = [];
      for (const u of graph.unions) {
        if (!at.has(u.id)) continue;
        for (const p of u.partners) if (at.has(p)) links.push([p, u.id]);
        for (const k of u.children) if (at.has(k.id)) links.push([u.id, k.id]);
      }
      const bends = new Map(c.bends.map((b) => [`${b.s}>${b.t}`, b.points]));
      for (const [s, t] of links) {
        const span = at.get(t) - at.get(s);
        assert.ok(span >= 1, `${s} -> ${t} points down`);
        const points = bends.get(`${s}>${t}`);
        if (span === 1) assert.equal(points, undefined, `${s} -> ${t} spans one layer and has no bend`);
        else {
          longLinks++;
          assert.equal(points?.length, span - 1, `${s} -> ${t} spans ${span} layers`);
        }
      }
      assert.equal(c.bends.length, links.filter(([s, t]) => at.get(t) - at.get(s) > 1).length);
    }
    assert.ok(longLinks > 0, 'the fixture has at least one link that spans several layers');
  });

  it('is sorted by id throughout', () => {
    const sorted = (list, key) => list.every((x, i) => i === 0 || key(list[i - 1]) <= key(x));
    assert.ok(sorted(layout.components, (c) => c.component));
    for (const c of layout.components) {
      assert.ok(sorted(c.people, (n) => n.id));
      assert.ok(sorted(c.unions, (n) => n.id));
      assert.ok(sorted(c.bends, (b) => `${b.s}\u0000${b.t}`));
    }
  });

  it('passes verify() and is optional in the schema', () => {
    assert.deepEqual(verifyGraph(graph, { now: NOW }), { ok: true, violations: [] });
    const { layout: _dropped, ...without } = graph;
    assert.deepEqual(verifyGraph(without, { now: NOW }), { ok: true, violations: [] });
    assert.ok(!loadSchema().required.includes('layout'));
  });
});

describe('the schema for layout', () => {
  const schema = loadSchema();
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  const ajvValidate = ajv.compile(schema);
  const { graph } = messy();
  const clone = (x) => structuredClone(x);
  const accept = (g) => {
    assert.equal(ajvValidate(g), true, JSON.stringify(ajvValidate.errors));
    assert.deepEqual(validateSchema(schema, g), []);
  };
  const reject = (g, label) => {
    assert.equal(ajvValidate(g), false, `ajv accepted: ${label}`);
    assert.notDeepEqual(validateSchema(schema, g), [], `built-in validator accepted: ${label}`);
  };

  it('accepts the block, with or without it, and the committed golden (which has none of the messy shapes, but has the block)', () => {
    accept(graph);
    const { layout: _dropped, ...without } = graph;
    accept(without);
    accept(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });

  it('rejects an unknown key at every object of the block (additionalProperties false)', () => {
    const paths = [];
    const walk = (v, ptr) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...ptr, i]));
      else if (v && typeof v === 'object') {
        paths.push(ptr);
        for (const [k, x] of Object.entries(v)) walk(x, [...ptr, k]);
      }
    };
    walk(graph.layout, ['layout']);
    assert.ok(paths.length > 20);
    for (const ptr of paths) {
      const g = clone(graph);
      ptr.reduce((n, k) => n[k], g).extra = 1;
      reject(g, `extra key at /${ptr.join('/')}`);
    }
  });

  it('pins the engine and the params, and wants integers', () => {
    for (const [label, edit] of [
      ['engine d3-dag@1.2.2', (g) => (g.layout.engine = 'd3-dag@1.2.2')],
      ['engine 1.2.3', (g) => (g.layout.engine = 'd3-dag 1.2.3')],
      ['coord simplex', (g) => (g.layout.params.coord = 'simplex')],
      ['layering', (g) => (g.layout.params.layering = 'longestPath')],
      ['decross opt', (g) => (g.layout.params.decross = 'opt')],
      ['nodeSize', (g) => (g.layout.params.nodeSize = [100, 50])],
      ['fractional x', (g) => (g.layout.components[0].people[0].x = 1.5)],
      ['string y', (g) => (g.layout.components[0].unions[0].y = '45')],
      ['bend point of 3', (g) => g.layout.components[0].bends[0].points.push([1, 2, 3])],
      ['missing params', (g) => delete g.layout.params],
      ['missing components', (g) => delete g.layout.components],
    ]) {
      const g = clone(graph);
      edit(g);
      reject(g, label);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// AC3: only components of at least 2 people; singletons and cycle members are filtered before d3-dag runs

describe('what is laid out', () => {
  const { graph, report } = messy();
  const laidOut = new Set(graph.layout.components.flatMap((c) => c.people.map((n) => n.id)));
  const laidOutUnions = new Set(graph.layout.components.flatMap((c) => c.unions.map((n) => n.id)));

  it('the fixture has a cycle, a singleton and four components of two or more people', () => {
    assert.deepEqual(report.warnings.find((w) => w.code === 'GRAPH_CYCLE').ids, ['I8031', 'I8032', 'I8033']);
    const solo = graph.components.find((c) => c.roots.includes('I8040'));
    assert.equal(solo.size, 1);
    assert.equal(graph.people.find((p) => p.id === 'I8040').generation, 0, 'a singleton is its own component at generation 0');
    assert.deepEqual(graph.people.filter((p) => p.generation === null).map((p) => p.id), ['I8031', 'I8032', 'I8033']);
  });

  it('leaves the singleton out', () => {
    assert.ok(!laidOut.has('I8040'));
    assert.ok(!graph.layout.components.some((c) => c.component === graph.people.find((p) => p.id === 'I8040').component));
  });

  it('emits no GRAPH_CYCLE member, and no union that only they hold', () => {
    for (const id of ['I8031', 'I8032', 'I8033']) assert.ok(!laidOut.has(id), `${id} is not laid out`);
    assert.ok(!laidOutUnions.has('F8011') && !laidOutUnions.has('F8012'));
    const text = JSON.stringify(graph.layout);
    for (const id of ['I8031', 'I8032', 'I8033', 'F8011', 'F8012', 'I8040']) assert.ok(!text.includes(id), `${id} is not in the block`);
  });

  it('lays out exactly the people with a generation, in components of at least 2', () => {
    const size = new Map();
    for (const p of graph.people) if (p.generation !== null) size.set(p.component, (size.get(p.component) ?? 0) + 1);
    const expected = graph.people.filter((p) => p.generation !== null && size.get(p.component) >= 2).map((p) => p.id).sort();
    assert.deepEqual([...laidOut].sort(), expected);
    assert.deepEqual(graph.layout.components.map((c) => c.component), [...new Set(graph.people.filter((p) => laidOut.has(p.id)).map((p) => p.component))].sort((a, b) => a - b));
  });

  it('d3-dag 1.2.2 itself would lay a cyclic graph out without an error, so the filter is the only guard', () => {
    // Two people who are each other's parent, plus a child of one.
    const dag = graphStratify()([
      { id: 'a', parentIds: ['b'] },
      { id: 'b', parentIds: ['a'] },
      { id: 'c', parentIds: ['a'] },
    ]);
    assert.equal(dag.acyclic(), false);
    const out = sugiyama().layering(layeringSimplex()).decross(decrossTwoLayer()).coord(coordGreedy())(dag);
    assert.ok(Number.isFinite(out.width) && Number.isFinite(out.height));
  });

  it('a graph made only of singletons and a cycle has an empty layout, not an error', () => {
    const people = [
      { id: 'I1', generation: 0, component: 0 },
      { id: 'I2', generation: null, component: 1 },
      { id: 'I3', generation: null, component: 1 },
    ];
    const unions = [{ id: 'F1', partners: ['I2'], children: [{ id: 'I3' }] }, { id: 'F2', partners: ['I3'], children: [{ id: 'I2' }] }];
    assert.deepEqual(computeLayout(people, unions).components, []);
  });

  it('a component whose people are all but one on a cycle is a singleton for the layout', () => {
    const people = [
      { id: 'I1', generation: 0, component: 0 },
      { id: 'I2', generation: null, component: 0 },
    ];
    assert.deepEqual(computeLayout(people, [{ id: 'F1', partners: ['I1'], children: [{ id: 'I2' }] }]).components, []);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// AC4: the messy fixture

describe('the messy fixture', () => {
  const { graph } = messy();

  it('has the shapes the poster must survive', () => {
    const u = (id) => graph.unions.find((x) => x.id === id);
    assert.deepEqual(graph.unions.filter((x) => x.partners.includes('I8003')).map((x) => x.id), ['F8002', 'F8003']); // two partner families
    assert.deepEqual(u('F8004').partners, ['I8004']); // mother-only
    assert.deepEqual(u('F8005').partners, []); // parentless siblings
    assert.equal(u('F8005').children.length, 2);
    assert.deepEqual(graph.unions.filter((x) => x.children.some((c) => c.id === 'I8007')).map((x) => x.id), ['F8002', 'F8008']); // birth and adoptive parents
    assert.deepEqual(u('F8008').children[0].rel, { I8018: 'adopted', I8019: 'adopted' });
    const g = (id) => graph.people.find((p) => p.id === id).generation;
    assert.equal(g('I8008'), g('I8010')); // first cousins ...
    assert.deepEqual(u('F8009').partners.sort(), ['I8008', 'I8010']); // ... who are partners: pedigree collapse
    assert.ok(graph.components.length >= 5);
  });

  it('places each laid-out person once, and each union once', () => {
    const people = graph.layout.components.flatMap((c) => c.people.map((n) => n.id));
    const unions = graph.layout.components.flatMap((c) => c.unions.map((n) => n.id));
    assert.equal(new Set(people).size, people.length);
    assert.equal(new Set(unions).size, unions.length);
    assert.ok(people.length >= 20);
    for (const id of ['I8003', 'I8007', 'I8008', 'I8010', 'I8020', 'I8011']) assert.ok(people.includes(id), id);
  });

  it('puts no two nodes at one position', () => {
    for (const c of graph.layout.components) {
      const at = [...c.people, ...c.unions].map((n) => `${n.x},${n.y}`);
      assert.equal(new Set(at).size, at.length, `component ${c.component}`);
    }
  });

  it('puts every generation on one layer, even with parentless siblings and the cousin union', () => {
    const gen = new Map(graph.people.map((p) => [p.id, p.generation]));
    for (const c of graph.layout.components) {
      const ys = new Map();
      for (const n of c.people) {
        if (!ys.has(gen.get(n.id))) ys.set(gen.get(n.id), new Set());
        ys.get(gen.get(n.id)).add(n.y);
      }
      for (const [g, set] of ys) assert.equal(set.size, 1, `generation ${g} of component ${c.component} is on ${set.size} layers`);
      // and the layers run in generation order
      const rows = [...ys].sort((a, b) => a[0] - b[0]).map(([, set]) => [...set][0]);
      assert.deepEqual(rows, [...rows].sort((a, b) => a - b));
    }
  });

  it('keeps a partner family together: partners share a layer and the union sits below them', () => {
    const c = graph.layout.components[0];
    const y = new Map([...c.people, ...c.unions].map((n) => [n.id, n.y]));
    assert.equal(y.get('I8003'), y.get('I8005'));
    assert.ok(y.get('F8002') > y.get('I8003'));
    assert.ok(y.get('I8007') > y.get('F8002'));
    assert.equal(y.get('I8007'), y.get('I8008'));
  });

  it('gives byte-identical output for shuffled input', () => {
    const base = stringify(graph);
    assert.ok(base.includes('"layout":{'));
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
      assert.equal(stringify(build(shuffled(layoutMessyTree().list(), seed)).graph), base, `seed ${seed}`);
    }
  });

  it('is the same block when run twice', () => {
    assert.equal(JSON.stringify(messy().graph.layout), JSON.stringify(graph.layout));
  });

  it('leaves the snapshot digest alone: the layout is derived, not source content', () => {
    const { layout: _dropped, ...without } = graph;
    // the digest is computed from the projected body only, so adding or removing the block does not change it
    assert.match(without.source.snapshot, /^sha256:[0-9a-f]{8}$/);
    const second = build(layoutMessyTree().list()).graph;
    assert.equal(second.source.snapshot, graph.source.snapshot);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// AC6: verify() and the '@' rule

describe('verify() on the layout block', () => {
  const { graph } = messy();
  const stringsOf = (v, out = []) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => stringsOf(x, out));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        stringsOf(x, out);
      }
    }
    return out;
  };

  it('source.builder keeps main\'s hfy-graph@<version>, under its /source/ exemption and strict pattern', () => {
    assert.match(graph.source.builder, /^hfy-graph@\d+\.\d+\.\d+$/);
    assert.deepEqual(verifyGraph(graph, { now: NOW }), { ok: true, violations: [] });
    const bad = structuredClone(graph);
    bad.source.builder = 'hfy-graph 0.1.0'; // the ADR's rename is not needed, and the strict pattern rejects it
    assert.ok(verifyGraph(bad, { now: NOW }).violations.some((v) => v.pointer === '/source/builder' && v.rule === 'schema:pattern'));
  });

  it('no string or key in the layout block contains "@" or matches the day-precise date pattern', () => {
    const strings = stringsOf(graph.layout);
    assert.ok(strings.length > 50);
    const dates = DETECTORS.filter((d) => d.rule === 'day-precise-date');
    for (const s of strings) {
      assert.ok(!s.includes('@'), `no "@" in ${JSON.stringify(s)}`);
      assert.ok(!dates.some((d) => d.re.test(s)), `no date shape in ${JSON.stringify(s)}`);
    }
  });

  it('engine "d3-dag@1.2.2" is PRIVACY_VIOLATION (exit 4), through verify(), assertVerified() and the CLI', () => {
    const bad = structuredClone(graph);
    bad.layout.engine = 'd3-dag@1.2.2';
    const r = verifyGraph(bad, { now: NOW });
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.pointer === '/layout/engine' && v.rule === 'email'), JSON.stringify(r.violations));
    assert.throws(
      () => assertVerified(bad, { now: NOW }),
      (e) => e instanceof GraphError && e.code === 'PRIVACY_VIOLATION' && e.exitCode === 4 && e.pointers.some((p) => p.startsWith('/layout/engine')),
    );
    const file = join(scratch(), 'graph.json');
    writeFileSync(file, stringify(bad));
    const cli = run(['--verify', file]);
    assert.equal(cli.status, 4, cli.stderr);
    assert.match(cli.stderr, /\/layout\/engine/);
    assert.ok(!cli.stderr.includes('d3-dag@'), 'the message names the pointer, never the value');
  });

  it('an "@" anywhere else in the block is caught by the same scan', () => {
    const bad = structuredClone(graph);
    bad.layout.components[0].people[0].id = 'I1@x';
    assert.equal(verifyGraph(bad, { now: NOW }).ok, false);
  });

  it('a version shaped like a date would be flagged too, so a pin change re-runs this test (ADR 4.7)', () => {
    const date = DETECTORS.filter((d) => d.rule === 'day-precise-date');
    assert.ok(!date.some((d) => d.re.test('d3-dag 1.2.2')));
    assert.ok(date.some((d) => d.re.test('d3-dag 1.10.12')));
  });

  it('rejects a layout that names a person or union the graph does not have, a duplicate, or a person without a generation', () => {
    const cases = [
      ['dangling person', (g) => (g.layout.components[0].people[0].id = 'I0000'), 'dangling-reference'],
      ['dangling union', (g) => (g.layout.components[0].unions[0].id = 'F0000'), 'dangling-reference'],
      ['dangling bend end', (g) => (g.layout.components[0].bends[0].t = 'I0000'), 'dangling-reference'],
      ['duplicate person', (g) => g.layout.components[0].people.push({ ...g.layout.components[0].people[0] }), 'layout-duplicate'],
      ['unknown component', (g) => (g.layout.components[0].component = 99), 'layout-component'],
      ['cycle member', (g) => (g.layout.components[0].people[0].id = 'I8031'), 'layout-person-not-placed'],
      ['a generation split across two layers', (g) => (g.layout.components[0].people[0].y += 1), 'layout-rank-order'],
      [
        'a deeper generation drawn above a shallower one',
        (g) => {
          const gen = new Map(g.people.map((p) => [p.id, p.generation]));
          for (const n of g.layout.components[0].people) n.y = -n.y * (gen.get(n.id) + 1);
        },
        'layout-rank-order',
      ],
    ];
    for (const [label, edit, rule] of cases) {
      const bad = structuredClone(graph);
      assert.ok(bad.layout.components[0].bends.length > 0 || label !== 'dangling bend end');
      edit(bad);
      assert.ok(verifyGraph(bad, { now: NOW }).violations.some((v) => v.rule === rule), `${label}: ${rule}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the builder end to end

describe('the CLI writes the block', () => {
  it('a dry run and a --out run both carry the layout, and --verify passes the written file', async () => {
    const { writeJsonl } = await import('./helpers.mjs');
    const dir = scratch();
    const input = writeJsonl(join(dir, 'in.jsonl'), layoutMessyTree().list());
    const out = join(dir, 'out');
    const r = run([input, '--out', out, '--generated-at', GENERATED_AT, '--report', join(dir, 'report.json')]);
    assert.equal(r.status, 0, r.stderr);
    const written = JSON.parse(readFileSync(join(out, 'person', 'graph.json'), 'utf8'));
    assert.equal(written.minor, 3);
    assert.equal(written.layout.engine, 'd3-dag 1.2.2');
    assert.equal(run(['--verify', join(out, 'person', 'graph.json')]).status, 0);
  });
});
