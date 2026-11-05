// The "how are we related?" panel's model (HFY-TSK-307, viz-v2-kinship-ui; flag familyVizKinship; viz.md section 14 and ADR 9.2). Pure, no DOM:
// tests/kinship-ui.test.mjs runs it in node on synthetic graphs. It reads family-graph.js (relationPaths, relationLabel, HFY-TSK-270) and adds
// only the shape the panel draws: the routes from the viewer to the person, grouped so a couple of common ancestors is one step, and the
// one plain sentence. Labels are words, never derived from colour.
//
//   kinshipModel(graph, viewer, other)  {state, phrase, routes}
//       state    "self" | "related" | "marriage" | "none" | "missing"
//       phrase   the sentence after the person's name ("is your first cousin."); "" when state is "self" or "missing"
//       hidden   how many routes beyond ROUTE_CAP were left out (0 almost always)
//       routes   [{steps:[{ids:[id...], tag, cards:[{id, label}]}], key}], each from the viewer (first step) to the person (last step); two or more when
//                the same people are related through different ancestors (pedigree collapse), most direct first
//   grandparentsOf(graph, viewer)       [{id, name, label}] the viewer's grandparents
//   cousinsOf(graph, viewer)            [{id, name, label}] the viewer's first cousins (children of the parents' brothers and sisters)

import { RELATED_BY_MARRIAGE, isRelationWord, relationLabel } from "./family-graph.js";

export const ROUTE_CAP = 6;
export const COUSIN_CAP = 12;

export const COPY = {
  title: "how are we related?",
  pill: "how are we related?",
  self: "that's you.",
  none: "isn't connected to you in the tree yet.",
  marriage: "is related to you by marriage.",
  missing: "we couldn't find that person in the tree.",
  ancestor: "common ancestor",
  partner: "partner",
  moreRoutes: (n) => `${n} more ${n === 1 ? "route" : "routes"} not shown.`,
  stepParent: "parent's partner",
  you: "you",
  grandparents: "my grandparents",
  cousins: "my cousins",
  grandparentsNone: "no grandparents recorded yet.",
  cousinsNone: "no cousins recorded yet.",
  loadFailed: "this didn't load. try again.",
  close: "close"
};

/** Group the shortest paths into routes: paths that differ only in which ancestor of a couple they go through are one route. */
function groupPaths(paths) {
  const groups = new Map();
  for (const p of paths) {
    const key = p.kind === "blood" ? `b:${p.up.slice(0, -1).join(",")}|${p.down.slice(1).join(",")}` : `p:${p.nodes.join(",")}`;
    let g = groups.get(key);
    if (!g) { g = { key, path: p, ancestors: [] }; groups.set(key, g); }
    const anc = p.kind === "blood" ? p.ancestor : p.blood?.ancestor;
    if (anc && !g.ancestors.includes(anc)) g.ancestors.push(anc);
  }
  return [...groups.values()];
}

function stepsOf(graph, viewer, group) {
  const { path, ancestors } = group;
  const nodes = path.nodes;
  // Where the common ancestor sits in the chain (a blood path always has one; a partner path has one inside its blood leg, or none).
  const ancestorAt = path.kind === "blood" ? path.up.length - 1 : path.blood?.ancestor ? nodes.indexOf(path.blood.ancestor) : -1;
  return nodes.map((id, i) => {
    let tag = "";
    if (i === 0) tag = COPY.you;
    else if (i === ancestorAt && ancestors.length) tag = COPY.ancestor;
    else if (path.kind === "partner") {
      if ((path.side === "direct" && i === 1) || (path.side === "a" && i === 1) || (path.side === "b" && i === nodes.length - 2)) tag = COPY.partner;
      else if (path.side === "mid" && i === 2) tag = COPY.stepParent;
    }
    const ids = i === ancestorAt && ancestors.length ? ancestors : [id];
    // Each card says what that person is to the viewer; the step's tag ("common ancestor", "partner") is added after it.
    const cards = ids.map((cid) => {
      const rel = relationLabel(graph, viewer, cid);
      const word = i === 0 ? COPY.you : isRelationWord(rel) ? rel : "";
      return { id: cid, label: [word, tag && i !== 0 ? tag : ""].filter(Boolean).join(", ") };
    });
    return { ids, tag, cards };
  });
}

export function kinshipModel(graph, viewer, other) {
  if (!graph || !graph.has(viewer) || !graph.has(other)) return { state: "missing", phrase: "", routes: [] };
  if (viewer === other) return { state: "self", phrase: "", routes: [] };
  const label = relationLabel(graph, viewer, other);
  const paths = graph.relationPaths(viewer, other);
  // RELATED_BY_MARRIAGE is what relationLabel says when a longer chain of parent and partner links joins the two but no short path does.
  if (label === RELATED_BY_MARRIAGE) return { state: "marriage", phrase: COPY.marriage, routes: [] };
  if (!paths.length || !isRelationWord(label)) return { state: "none", phrase: COPY.none, routes: [] };
  const all = groupPaths(paths);
  const groups = all.slice(0, ROUTE_CAP);
  const routes = groups.map((g) => ({ key: g.key, steps: stepsOf(graph, viewer, g) }));
  // The sentence counts every route found, not only the ones drawn; `hidden` says how many the panel left out.
  const phrase = all.length > 1 ? `is your ${label}, through ${all.length} different routes.` : `is your ${label}.`;
  return { state: "related", phrase, routes, hidden: all.length - routes.length };
}

const entry = (graph, viewer, id) => {
  const label = relationLabel(graph, viewer, id);
  return { id, name: graph.person(id)?.name || id, label: isRelationWord(label) ? label : "" };
};

export function grandparentsOf(graph, viewer) {
  if (!graph || !graph.has(viewer)) return [];
  return graph.grandparents(viewer).map((g) => entry(graph, viewer, g.id));
}

export function cousinsOf(graph, viewer) {
  if (!graph || !graph.has(viewer)) return [];
  const mine = new Set([viewer, ...graph.parents(viewer).map((p) => p.id)]);
  const out = [];
  const seen = new Set();
  for (const g of graph.grandparents(viewer)) {
    for (const aunt of graph.children(g.id)) {
      if (mine.has(aunt.id)) continue;
      for (const c of graph.children(aunt.id)) if (!mine.has(c.id) && !seen.has(c.id)) { seen.add(c.id); out.push(entry(graph, viewer, c.id)); }
    }
  }
  return out;
}
