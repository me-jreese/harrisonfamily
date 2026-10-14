// buildFamilyGraph(objects, opts) -> { graph, faceJobs, report }. Pure: no file, network or clock access
// (the clock comes in as opts.generatedAt or opts.now).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Warnings, projectRecords } from './project.mjs';
import { canonicalize } from './canonical.mjs';
import { GraphError } from './errors.mjs';
import { geocodePlaces } from './geocode.mjs';
import { computeGenerations } from './generations.mjs';
import { computeLayout } from './layout.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const BUILDER = `hfy-graph@${pkg.version}`;
export const SCHEMA_VERSION = 1;
export const MINOR = 3; // 1: places[].geo may be "naturalearth" (state, province and country centroids); 2: photoEdges; 3: the optional layout block
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
 * @param {{ generatedAt?: string, now?: Date|number, sourceKind?: string, keepLivingResidence?: boolean, gazetteer?: object|null }} [opts]
 *   gazetteer: parseGazetteer() output (gazetteer.mjs); null or absent means GAZETTEER_MISSING (Gramps coordinates only)
 */
export function buildFamilyGraph(objects, opts = {}) {
  const now = resolveNow(opts.now);
  const generatedAt = opts.generatedAt ?? isoSeconds(now);
  const warnings = new Warnings();
  const { people, unions, places: projected, events, photoEdges, faceJobs } = projectRecords(objects, {
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
  const used = new Set([...events.map((e) => e.place), ...people.flatMap((p) => [p.birthPlace, p.deathPlace])].filter(Boolean));
  const geo = geocodePlaces(projected, opts.gazetteer ?? null, { warnings, used });
  const places = geo.places;

  const body = {
    people,
    unions,
    edges,
    places,
    events,
    components,
    generations,
    photoEdges, // photo co-occurrence (minor 2); ids only, no handles, rects or paths
    attribution: { geonames: geo.geonames }, // any GeoNames coordinate needs the credit (GEONAMES_CREDIT)
  };
  // Derived from the body (people, unions, generations), so it is left out of the snapshot digest, which names the content.
  const layout = computeLayout(people, unions);
  const digest = snapshotDigest(body);
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
    layout,
  };
  // geocode: per place, the source, the coordinates, and for a GeoNames match its geonameId, population and runner-up (local only)
  const report = { builder: BUILDER, generatedAt, counts: graph.counts, warnings: warnings.toList(), geocode: geo.entries };
  return { graph, faceJobs, report };
}

const BODY_KEYS = ['people', 'unions', 'edges', 'places', 'events', 'components', 'generations', 'photoEdges', 'attribution'];

// The snapshot id is a digest of the projected content, so it is the same for any input order and never touches the
// unredacted input.
function snapshotDigest(body) {
  const picked = Object.fromEntries(BODY_KEYS.map((k) => [k, body[k]]));
  return createHash('sha256').update(JSON.stringify(canonicalize(picked))).digest('hex').slice(0, 8);
}

/**
 * Sets each person's `face` from the face crops (faces.mjs: gramps id -> "faces/<id>-<sha8>.webp" or null), `counts.faces`,
 * and the snapshot digest, which covers the faces too. Returns the same graph.
 */
export function applyFaces(graph, faces) {
  for (const p of graph.people) p.face = faces.get(p.id) ?? null;
  graph.counts.faces = graph.people.filter((p) => p.face !== null).length;
  graph.source.snapshot = `sha256:${snapshotDigest(graph)}`;
  return graph;
}
