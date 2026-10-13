// buildFamilyGraph(objects, opts) -> { graph, faceJobs, report }. Pure: no file, network or clock access
// (the clock comes in as opts.generatedAt or opts.now).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Warnings, projectRecords } from './project.mjs';
import { canonicalize } from './canonical.mjs';
import { GraphError } from './errors.mjs';

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

/** Connected components over union membership: ids by size descending, ties by the smallest gramps id. */
export function computeComponents(people, unions) {
  const parent = new Map(people.map((p) => [p.id, p.id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const join = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  const hasParent = new Set();
  for (const u of unions) {
    const members = [...u.partners, ...u.children.map((c) => c.id)];
    for (const m of members.slice(1)) join(members[0], m);
    if (u.partners.length > 0) for (const c of u.children) hasParent.add(c.id);
  }
  const groups = new Map();
  for (const p of people) {
    const r = find(p.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p.id);
  }
  const list = [...groups.values()].map((ids) => ids.sort(cmp));
  list.sort((a, b) => b.length - a.length || cmp(a[0], b[0]));
  const of = new Map();
  const components = list.map((ids, i) => {
    for (const id of ids) of.set(id, i);
    return { id: i, size: ids.length, roots: ids.filter((id) => !hasParent.has(id)) };
  });
  return { components, of };
}

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
  const { components, of } = computeComponents(people, unions);
  for (const p of people) p.component = of.get(p.id);

  const body = {
    people,
    unions,
    edges,
    places,
    events,
    components,
    generations: [], // filled by the generation index (viz-generation-index)
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
