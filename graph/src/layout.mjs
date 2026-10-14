// The poster layout block (ADR 4.7; task viz-graph-v2-layout). d3-dag 1.2.2 runs here, at build time, so no layout
// code ever reaches the client.
//
// The layout graph has two kinds of node: a person, and a union. Links run partner -> union -> child, so a union with
// two partners and three children is two links in and three out, and a child of two unions has two parents. Ranks come
// from the generation index (generations.mjs), which keeps every generation on one layer:
//
//   a person                       2 x generation
//   a union with partners          2 x (the highest partner generation) + 1
//   a union without partners       2 x (the lowest child generation) - 1
//
// Operators: layeringSimplex with those ranks, decrossTwoLayer, coordGreedy. Never coordSimplex (217 s and 1,750 s at
// 2,000 people, against 12.9 s and 8.8 s) and never decrossOpt (NP-complete).
//
// Only components with at least 2 laid-out people are laid out. A singleton is left out, and so is every person whose
// generation is null (a GRAPH_CYCLE member or a descendant of one): d3-dag 1.2.2 lays a cyclic graph out without an
// error, so the filter runs before d3-dag sees anything.
//
// Pure and deterministic. d3-dag gets its nodes in id order, coordinates are rounded to integers, and every array is
// sorted by id, so shuffled input gives the same block.

import { graphStratify, sugiyama, layeringSimplex, decrossTwoLayer, coordGreedy } from 'd3-dag';

/** "d3-dag 1.2.2", with a space: verify() rejects any "@" in a string, and the schema pins this exact value. */
export const ENGINE = 'd3-dag 1.2.2';
export const NODE_SIZE = Object.freeze([180, 90]);
export const PARAMS = Object.freeze({ layering: 'simplex+rank', decross: 'twoLayer', coord: 'greedy', nodeSize: NODE_SIZE });

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byId = (a, b) => cmp(a.id, b.id);
const int = (n) => Math.round(n) + 0; // + 0 turns -0 into 0

/**
 * @param {{ id: string, generation: number|null, component: number }[]} people  generation and component filled in
 * @param {{ id: string, partners: string[], children: { id: string }[] }[]} unions
 * @returns {{ engine: string, params: object, components: object[] }}
 */
export function computeLayout(people, unions) {
  // 1. who is laid out: a known generation, in a component with at least 2 such people
  const placed = people.filter((p) => Number.isInteger(p.generation));
  const byComponent = new Map();
  for (const p of placed) {
    if (!byComponent.has(p.component)) byComponent.set(p.component, []);
    byComponent.get(p.component).push(p);
  }
  const generationOf = new Map(placed.map((p) => [p.id, p.generation]));
  const sortedUnions = [...unions].sort(byId);

  const components = [];
  for (const component of [...byComponent.keys()].sort((a, b) => a - b)) {
    const members = byComponent.get(component).sort(byId);
    if (members.length < 2) continue;
    components.push(layoutComponent(component, members, sortedUnions, generationOf));
  }
  return { engine: ENGINE, params: { ...PARAMS, nodeSize: [...NODE_SIZE] }, components };
}

function layoutComponent(component, members, sortedUnions, generationOf) {
  const inComponent = new Set(members.map((p) => p.id));
  // person and union ids come from different Gramps namespaces, but nothing here depends on that: the keys are prefixed
  const pkey = (id) => `p:${id}`;
  const ukey = (id) => `u:${id}`;
  const rank = new Map(members.map((p) => [pkey(p.id), 2 * generationOf.get(p.id)]));
  const parentUnions = new Map(members.map((p) => [p.id, []]));
  const nodes = [];

  for (const u of sortedUnions) {
    const partners = [...new Set(u.partners)].filter((id) => inComponent.has(id)).sort(cmp);
    const children = [...new Set(u.children.map((c) => c.id))].filter((id) => inComponent.has(id) && !partners.includes(id)).sort(cmp);
    if (partners.length + children.length === 0) continue;
    rank.set(
      ukey(u.id),
      partners.length > 0
        ? 2 * Math.max(...partners.map((id) => generationOf.get(id))) + 1
        : 2 * Math.min(...children.map((id) => generationOf.get(id))) - 1,
    );
    for (const c of children) parentUnions.get(c).push(u.id);
    nodes.push({ key: ukey(u.id), parentIds: partners.map(pkey) });
  }
  for (const p of members) nodes.push({ key: pkey(p.id), parentIds: parentUnions.get(p.id).sort(cmp).map(ukey) });
  nodes.sort((a, b) => cmp(a.key, b.key));

  const dag = graphStratify().id((d) => d.key).parentIds((d) => d.parentIds)(nodes);
  const { width, height } = sugiyama()
    .layering(layeringSimplex().rank((n) => rank.get(n.data.key)))
    .decross(decrossTwoLayer())
    .coord(coordGreedy())
    .nodeSize([...NODE_SIZE])(dag);

  const out = { component, width: int(width), height: int(height), people: [], unions: [], bends: [] };
  for (const n of dag.nodes()) {
    const at = { id: n.data.key.slice(2), x: int(n.x), y: int(n.y) };
    (n.data.key.startsWith('u:') ? out.unions : out.people).push(at);
  }
  // A link between neighbouring layers is a straight segment and has no bend. A longer one passes through one point per
  // layer it crosses; the two end points (the nodes themselves) are not repeated.
  for (const l of dag.links()) {
    if (l.points.length <= 2) continue;
    out.bends.push({
      s: l.source.data.key.slice(2),
      t: l.target.data.key.slice(2),
      points: l.points.slice(1, -1).map(([x, y]) => [int(x), int(y)]),
    });
  }
  out.people.sort(byId);
  out.unions.sort(byId);
  out.bends.sort((a, b) => cmp(a.s, b.s) || cmp(a.t, b.t));
  return out;
}
