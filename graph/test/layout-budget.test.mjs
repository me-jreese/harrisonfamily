// viz-graph-v2-layout AC5: the size and time budgets on seeded synthetic families (invented names, places and ids).
//
//   graph.json gzip with the layout block and photoEdges   at most  25 KB at 231 people, 150 KB at 2,000     run everywhere
//   layout time                                            at most   5 s at 231 people                      run everywhere, CI included
//   layout time                                            at most  60 s at 2,000 people                    only with HFY_GRAPH_PERF=1
//
// A miss fails the test. The remedy is an amendment to the visualization ADR (for example a separate gated layout file), never
// a silent change to a number here.
//
// "Layout time" is the CPU time the layout call used (user plus system, all threads of this process). It is the same work as the
// wall clock on an idle machine (the CPU figure also counts the garbage collector and JIT threads, so it is never the smaller
// one there), but it does not count the time the process spent waiting for a core. The wall-clock time is printed next to it.
// A busy worker (the measurements below ran at a load average near 90) can stretch a 13 s layout to over a minute of wall time. The measured times and the Node version are printed as test diagnostics: they are the
// acceptance evidence (ADR 3.3 measured Node 24.10.0, and the graph/ engines floor is Node 22).
//
// photoEdges (viz-graph-v2-data) is not in the builder yet, so the size test adds a synthetic array of the ADR 4.7 shape to the
// measured file: one tagged photo per person, each tagging 1 to 4 people (the ADR's "one photo per person" density).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { buildFamilyGraph } from '../src/build.mjs';
import { stringify } from '../src/canonical.mjs';
import { computeGenerations } from '../src/generations.mjs';
import { computeLayout } from '../src/layout.mjs';
import { Warnings, projectRecords } from '../src/project.mjs';
import { synthTree } from './fixtures/synth.mjs';
import { NOW } from './helpers.mjs';

const KB = 1024;
const PERF = process.env.HFY_GRAPH_PERF === '1';
const LAYOUT_MS_231 = 5_000;
const LAYOUT_MS_2000 = 60_000;
const GZIP_231 = 25 * KB;
const GZIP_2000 = 150 * KB;

/** The projected people and unions with generation and component filled in, ready for computeLayout. */
function prepared(n, seed) {
  const { people, unions } = projectRecords(synthTree(n, seed).list(), { maxYear: NOW.getUTCFullYear(), warnings: new Warnings() });
  const g = computeGenerations(people, unions);
  for (const p of people) {
    p.component = g.of.get(p.id);
    p.generation = g.generation.get(p.id);
  }
  return { people, unions };
}

/** Wall-clock and CPU milliseconds of one computeLayout call (see the header: the budgets use the CPU figure). */
function timed(people, unions) {
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const layout = computeLayout(people, unions);
  const wall = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  return { layout, wallMs: Math.round(wall), cpuMs: Math.round((cpu.user + cpu.system) / 1000) };
}

function photoEdges(graph, seed) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const ids = graph.people.map((p) => p.id);
  return ids.map((_, i) => {
    const tagged = new Set();
    const k = 1 + Math.floor(rnd() * 4);
    while (tagged.size < k) tagged.add(ids[Math.floor(rnd() * ids.length)]);
    return { media: `O${String(10001 + i)}`, people: [...tagged].sort() };
  });
}

function gzipBytes(n, seed) {
  const { graph } = buildFamilyGraph(synthTree(n, seed).list(), { now: NOW, generatedAt: '2026-10-20T18:04:00Z' });
  assert.equal(graph.people.length, n);
  const withPhotos = { ...graph, photoEdges: photoEdges(graph, seed) };
  return {
    graph,
    withLayout: gzipSync(stringify(graph)).length,
    withLayoutAndPhotos: gzipSync(stringify(withPhotos)).length,
    withoutLayout: gzipSync(stringify({ ...graph, layout: undefined })).length,
  };
}

describe('layout time', () => {
  for (const seed of [42, 7]) {
    it(`231 people (seed ${seed}) lay out in at most 5 s`, (t) => {
      const { people, unions } = prepared(231, seed);
      const { layout, wallMs, cpuMs } = timed(people, unions);
      t.diagnostic(`layout time ${wallMs} ms wall, ${cpuMs} ms cpu at 231 people, seed ${seed}, Node ${process.version}; budget ${LAYOUT_MS_231} ms`);
      assert.ok(layout.components.length >= 1);
      assert.ok(cpuMs <= LAYOUT_MS_231, `layout used ${cpuMs} ms of CPU (${wallMs} ms wall) at 231 people, over the ${LAYOUT_MS_231} ms budget: amend the ADR, do not change this number`);
    });
  }

  for (const seed of [42, 7]) {
    it(`2,000 people (seed ${seed}) lay out in at most 60 s (HFY_GRAPH_PERF=1 only)`, { skip: !PERF && 'set HFY_GRAPH_PERF=1 (the worker and io\'s machine, never shared CI runners)' }, (t) => {
      const { people, unions } = prepared(2000, seed);
      const { layout, wallMs, cpuMs } = timed(people, unions);
      t.diagnostic(`layout time ${wallMs} ms wall, ${cpuMs} ms cpu at 2000 people, seed ${seed}, Node ${process.version}; budget ${LAYOUT_MS_2000} ms`);
      assert.equal(layout.components[0].people.length > 1900, true, 'one main component holds nearly everyone');
      assert.ok(cpuMs <= LAYOUT_MS_2000, `layout used ${cpuMs} ms of CPU (${wallMs} ms wall) at 2,000 people, over the ${LAYOUT_MS_2000} ms budget: amend the ADR, do not change this number`);
    });
  }
});

describe('graph.json size with the layout block and photoEdges', () => {
  for (const seed of [42, 7]) {
    it(`231 people (seed ${seed}) stay within 25 KB gzipped`, (t) => {
      const r = gzipBytes(231, seed);
      t.diagnostic(`231 people, seed ${seed}: ${r.withoutLayout} B without layout, ${r.withLayout} B with layout, ${r.withLayoutAndPhotos} B with layout and photoEdges; budget ${GZIP_231} B`);
      assert.ok(r.withLayoutAndPhotos <= GZIP_231, `${r.withLayoutAndPhotos} B gzipped at 231 people, over ${GZIP_231} B: amend the ADR`);
    });
  }

  it('2,000 people (seed 42) stay within 150 KB gzipped', (t) => {
    const r = gzipBytes(2000, 42);
    t.diagnostic(`2000 people, seed 42: ${r.withoutLayout} B without layout, ${r.withLayout} B with layout, ${r.withLayoutAndPhotos} B with layout and photoEdges; budget ${GZIP_2000} B`);
    assert.ok(r.withLayoutAndPhotos <= GZIP_2000, `${r.withLayoutAndPhotos} B gzipped at 2,000 people, over ${GZIP_2000} B: amend the ADR`);
  });

  it('2,000 people (seed 7) stay within 150 KB gzipped (HFY_GRAPH_PERF=1 only)', { skip: !PERF && 'set HFY_GRAPH_PERF=1' }, (t) => {
    const r = gzipBytes(2000, 7);
    t.diagnostic(`2000 people, seed 7: ${r.withLayoutAndPhotos} B with layout and photoEdges; budget ${GZIP_2000} B`);
    assert.ok(r.withLayoutAndPhotos <= GZIP_2000);
  });
});

describe('the synthetic generator', () => {
  it('is seeded: the same (people, seed) gives the same tree, and another seed another one', () => {
    const a = JSON.stringify(synthTree(231, 42).list());
    assert.equal(JSON.stringify(synthTree(231, 42).list()), a);
    assert.notEqual(JSON.stringify(synthTree(231, 7).list()), a);
  });

  it('has a main component of about 8 generations, a second component and singletons, and lays out the whole main one', () => {
    const { people, unions } = prepared(231, 42);
    assert.equal(people.length, 231);
    const gens = new Set(people.filter((p) => p.component === 0).map((p) => p.generation));
    assert.ok(gens.size >= 6, `${gens.size} generations`);
    assert.ok(new Set(people.map((p) => p.component)).size >= 3);
    const { components } = computeLayout(people, unions);
    assert.ok(components[0].people.length >= 200);
  });
});
