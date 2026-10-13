// buildFamilyGraph(objects, opts) -> { graph, faceJobs, report }. Pure: no file, network or clock access
// (the clock comes in as opts.generatedAt or opts.now).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Warnings, projectRecords } from './project.mjs';
import { canonicalize } from './canonical.mjs';
import { GraphError } from './errors.mjs';
import { computeGenerations } from './generations.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const BUILDER = `hfy-graph@${pkg.version}`;
export const SCHEMA_VERSION = 1;
export const MINOR = 0;
export const PROJECTION = 1;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** edges are derived from unions, for generic graph libraries. Ordered by (s, t, kind, union). */
export function deriveEdges(unions) {
  const edges = [];
  for (const u of unions) {
    if (u.partners.length === 2) {
      edges.push({ s: u.partners[0], t: u.partners[1], kind: 'partner', union: u.id, type: u.type });
    }
    for (const c of u.children) {
      for (const parent of u.partners) {
        edges.push({ s: parent, t: c.id, kind: 'parent', union: u.id, rel: c.rel[parent] });
      }
    }
  }
  return edges.sort((a, b) => cmp(a.s, b.s) || cmp(a.t, b.t) || cmp(a.kind, b.kind) || cmp(a.union, b.union));
}

export { computeComponents } from './generations.mjs';

/** The clock input as a valid Date, or INPUT_MISSING (exit 2) instead of a RangeError from toISOString. */
export function resolveNow(now) {
  const d = now instanceof Date ? now : new Date(now ?? Date.now());
  if (Number.isNaN(d.getTime())) throw new GraphError('INPUT_MISSING', 'the clock value (now) is not a valid date');
  return d;
}

function isoSeconds(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * @param {object[]} objects  _class-tagged Gramps JSON objects (any order)
 * @param {{ generatedAt?: string, now?: Date|number, sourceKind?: string, keepLivingResidence?: boolean }} [opts]
 */
export function buildFamilyGraph(objects, opts = {}) {
  const now = resolveNow(opts.now);
  const generatedAt = opts.generatedAt ?? isoSeconds(now);
  const warnings = new Warnings();
  const { people, unions, places, events } = projectRecords(objects, {
    maxYear: now.getUTCFullYear(),
    warnings,
    keepLivingResidence: opts.keepLivingResidence === true,
  });
  const edges = deriveEdges(unions);
  const { components, of, generation, generations, cycle } = computeGenerations(people, unions);
  for (const p of people) {
    p.component = of.get(p.id);
    p.generation = generation.get(p.id);
  }
  for (const id of cycle) warnings.add('GRAPH_CYCLE', id); // local report only (viz.md 5.4)

  const body = {
    people,
    unions,
    edges,
    places,
    events,
    components,
    generations,
    attribution: { geonames: false },
  };
  // The snapshot id is a digest of the projected content, so it is the same for any input order and
  // never touches the unredacted input.
  const digest = createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex').slice(0, 8);
  const graph = {
    schemaVersion: SCHEMA_VERSION,
    minor: MINOR,
    generatedAt,
    source: { kind: opts.sourceKind ?? 'jsonl', snapshot: `sha256:${digest}`, builder: BUILDER, projection: PROJECTION },
    counts: {
      people: people.length,
      unions: unions.length,
      edges: edges.length,
      places: places.length,
      events: events.length,
      components: components.length,
      faces: 0,
    },
    ...body,
  };
  const report = { builder: BUILDER, generatedAt, counts: graph.counts, warnings: warnings.toList() };
  return { graph, faceJobs: [], report };
}
