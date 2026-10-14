// The family graph for the /tree/ page (viz domain, HFY-TSK-201; design viz.md sections 5.3 and 8). Pure functions and one class, no DOM and no
// network, so tests/family-graph.test.mjs runs them in node on synthetic graphs.
//
//   parseGraph(json)                    check the version and the shape; returns a FamilyGraph (throws GraphError)
//   new FamilyGraph(data)               person, parents, unionsOf, siblings, grandparents, relativeGeneration, neighborhood, levels
//   relationLabel(graph, viewer, other) a small kinship namer ("mother", "half-sister", "aunt"), null when the pair is not close
//
// graph.json v1 (viz.md 5.3): people[], unions[] (canonical: 0 to 2 partners, children with a per-parent rel), edges[] (derived, unused
// here), generations[] (per component, levels of ids). schemaVersion must be 1; any minor is accepted, unknown keys are ignored.

export const SCHEMA_VERSION = 1;

/** Thrown by parseGraph. `code` is the viz.md section 17 name: GRAPH_PARSE (bad body) or GRAPH_SCHEMA_UNSUPPORTED (bad version). */
export class GraphError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "GraphError";
    this.code = code;
  }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);

/** Parse a graph.json body (a string or an already parsed object) into a FamilyGraph. Never returns a half-valid graph. */
export function parseGraph(json) {
  let data = json;
  if (typeof json === "string") {
    try { data = JSON.parse(json); } catch { throw new GraphError("GRAPH_PARSE", "the graph is not valid JSON"); }
  }
  if (!isObj(data)) throw new GraphError("GRAPH_PARSE", "the graph is not an object");
  if (data.schemaVersion !== SCHEMA_VERSION) throw new GraphError("GRAPH_SCHEMA_UNSUPPORTED", `schemaVersion ${String(data.schemaVersion)} is not supported`);
  if (!Array.isArray(data.people) || !Array.isArray(data.unions)) throw new GraphError("GRAPH_PARSE", "people and unions must be arrays");
  const ids = new Set();
  for (const p of data.people) {
    if (!isObj(p) || typeof p.id !== "string" || !p.id || typeof p.name !== "string") throw new GraphError("GRAPH_PARSE", "a person needs a string id and name");
    if (ids.has(p.id)) throw new GraphError("GRAPH_PARSE", "duplicate person id");
    ids.add(p.id);
  }
  for (const u of data.unions) {
    if (!isObj(u) || typeof u.id !== "string" || !Array.isArray(u.partners) || u.partners.length > 2 || !u.partners.every((x) => typeof x === "string")) {
      throw new GraphError("GRAPH_PARSE", "a union needs an id and 0 to 2 partner ids");
    }
    if (!asArray(u.children).every((c) => isObj(c) && typeof c.id === "string")) throw new GraphError("GRAPH_PARSE", "a union child needs an id");
  }
  return new FamilyGraph(data);
}

/** The graph and its queries. Ids that the graph does not hold are skipped (a dangling reference never throws). */
export class FamilyGraph {
  constructor(data) {
    this.data = data;
    this.meta = { schemaVersion: data.schemaVersion, minor: data.minor ?? 0, generatedAt: data.generatedAt ?? null };
    this._people = new Map(data.people.map((p) => [p.id, p]));
    this._unions = data.unions.filter((u) => isObj(u));
    // Index once: union ids a person is a partner in, and union ids a person is a child of (with that child's rel map).
    this._asPartner = new Map();
    this._asChild = new Map();
    for (const u of this._unions) {
      for (const pid of u.partners) if (this._people.has(pid)) push(this._asPartner, pid, u);
      for (const c of asArray(u.children)) if (this._people.has(c.id)) push(this._asChild, c.id, { union: u, rel: isObj(c.rel) ? c.rel : {} });
    }
    this._levels = new Map(asArray(data.generations).map((g) => [g.component, asArray(g.levels)]));
  }

  get size() { return this._people.size; }
  /** All people, in the graph's own (gramps id) order. */
  people() { return [...this._people.values()]; }
  has(id) { return this._people.has(id); }
  person(id) { return this._people.get(id) || null; }

  /** [{id, rel}] the person's parents, once each; rel is the ChildRefType for that parent ("birth", "adopted", ... or "unknown"). */
  parents(id) {
    const out = [];
    const seen = new Set();
    for (const { union, rel } of this._asChild.get(id) || []) {
      for (const pid of union.partners) {
        if (!this._people.has(pid) || seen.has(pid)) continue;
        seen.add(pid);
        out.push({ id: pid, rel: typeof rel[pid] === "string" ? rel[pid] : "unknown" });
      }
    }
    return out;
  }

  /** [{union, partner, children:[{id, rel}]}] one entry per union the person is a partner in; partner is null for a one-parent union. */
  unionsOf(id) {
    return (this._asPartner.get(id) || []).map((u) => ({
      union: u,
      partner: u.partners.find((p) => p !== id && this._people.has(p)) ?? null,
      children: asArray(u.children).filter((c) => this._people.has(c.id)).map((c) => ({ id: c.id, rel: isObj(c.rel) && typeof c.rel[id] === "string" ? c.rel[id] : "unknown" }))
    }));
  }

  /** The person's partners, once each: [{id, union}] (a person with two unions to the same partner appears once). */
  partners(id) {
    const out = [];
    const seen = new Set();
    for (const { union, partner } of this.unionsOf(id)) if (partner && !seen.has(partner)) { seen.add(partner); out.push({ id: partner, union }); }
    return out;
  }

  /** [{id, half}] brothers and sisters: everyone who shares a recorded parent (through any of that parent's unions). half is false only when
   *  they have the same set of recorded parents. */
  siblings(id) {
    const myParents = new Set(this.parents(id).map((p) => p.id));
    const out = new Map();
    for (const pid of myParents) {
      for (const c of this.children(pid)) {
        if (c.id === id || out.has(c.id)) continue;
        const theirs = new Set(this.parents(c.id).map((p) => p.id));
        const same = theirs.size === myParents.size && [...myParents].every((p) => theirs.has(p));
        out.set(c.id, { id: c.id, half: !same });
      }
    }
    return [...out.values()];
  }

  /** [{id, via}] the parents of the person's parents; via is the parent in between. */
  grandparents(id) {
    const out = [];
    const seen = new Set();
    for (const p of this.parents(id)) {
      for (const g of this.parents(p.id)) if (!seen.has(g.id)) { seen.add(g.id); out.push({ id: g.id, via: p.id }); }
    }
    return out;
  }

  /** [{id, rel}] the person's children across every union, once each. */
  children(id) {
    const out = [];
    const seen = new Set();
    for (const u of this.unionsOf(id)) for (const c of u.children) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
    return out;
  }

  /** other.generation - person.generation (positive: `other` is younger), or null when either has none or they are in different components. */
  relativeGeneration(a, b) {
    const pa = this._people.get(a);
    const pb = this._people.get(b);
    if (!pa || !pb || !Number.isInteger(pa.generation) || !Number.isInteger(pb.generation) || pa.component !== pb.component) return null;
    return pb.generation - pa.generation;
  }

  /** The people within `up` generations of ancestors and `down` of descendants of `id` (default 2 and 1), plus the partners of everyone
   *  included, and the parent edges among them: {nodes: [ids], edges: [{s, t, kind, union}]}. Order is stable (breadth-first). */
  neighborhood(id, { up = 2, down = 1 } = {}) {
    if (!this._people.has(id)) return { nodes: [], edges: [] };
    const nodes = new Set([id]);
    const mark = (frontier, step, depth) => {
      let level = frontier;
      for (let d = 0; d < depth && level.length; d += 1) {
        const next = [];
        for (const n of level) for (const r of step(n)) if (!nodes.has(r.id)) { nodes.add(r.id); next.push(r.id); }
        level = next;
      }
    };
    mark([id], (n) => this.parents(n), up);
    mark([id], (n) => this.children(n), down);
    for (const n of [...nodes]) for (const p of this.partners(n)) nodes.add(p.id);
    const edges = [];
    for (const u of this._unions) {
      for (const c of asArray(u.children)) {
        if (!nodes.has(c.id)) continue;
        for (const pid of u.partners) if (nodes.has(pid)) edges.push({ s: pid, t: c.id, kind: "parent", union: u.id });
      }
      if (u.partners.length === 2 && u.partners.every((p) => nodes.has(p))) edges.push({ s: u.partners[0], t: u.partners[1], kind: "partner", union: u.id });
    }
    return { nodes: [...nodes], edges };
  }

  /** The generation levels of a component, oldest first: [[ids], ...]; [] for an unknown component. */
  levels(component) {
    return this._levels.get(component) || [];
  }

  /** How many people descend from `id` (children, their children, ...), counted once each; a cycle in the data cannot loop. */
  descendantCount(id) {
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length) for (const c of this.children(stack.pop())) if (!seen.has(c.id)) { seen.add(c.id); stack.push(c.id); }
    return seen.size - 1;
  }

  /** viz.md 9.4: the generation-0 person of component 0 with the most descendants (ties: first in the graph's order), else the first
   *  person at all; null for an empty graph. Used when `?focus` and the viewer are both absent from the graph. */
  defaultFocus() {
    const first = (this.levels(0)[0] || []).filter((id) => this._people.has(id));
    let best = null;
    let bestCount = -1;
    for (const id of first) { const n = this.descendantCount(id); if (n > bestCount) { best = id; bestCount = n; } }
    return best ?? this.people()[0]?.id ?? null;
  }

  /** People without a generation number: the outline's "not yet connected to the tree" group. */
  unconnected() {
    return this.people().filter((p) => p.generation === null || p.generation === undefined);
  }
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

const BY_SEX = {
  parent: { f: "mother", m: "father" },
  child: { f: "daughter", m: "son" },
  sibling: { f: "sister", m: "brother" },
  partner: { f: "wife", m: "husband" },
  grandparent: { f: "grandmother", m: "grandfather" },
  grandchild: { f: "granddaughter", m: "grandson" },
  uncle: { f: "aunt", m: "uncle" },
  nibling: { f: "niece", m: "nephew" }
};
const word = (kind, p) => (p && BY_SEX[kind][p.sex]) || { parent: "parent", child: "child", sibling: "sibling", partner: "partner", grandparent: "grandparent", grandchild: "grandchild", uncle: "aunt or uncle", nibling: "niece or nephew" }[kind];

/** What `other` is to `viewer`, for the focus card ("your mother"): "you", parent, child, sibling (half-), partner, grandparent, grandchild,
 *  aunt or uncle, niece or nephew, first cousin. Null when the pair is none of those (the card then shows no label). Unmarried partners
 *  are "partner" and married ones "wife" or "husband". */
export function relationLabel(graph, viewer, other) {
  if (!graph.has(viewer) || !graph.has(other)) return null;
  if (viewer === other) return "you";
  const o = graph.person(other);
  if (graph.parents(viewer).some((p) => p.id === other)) return word("parent", o);
  if (graph.children(viewer).some((c) => c.id === other)) return word("child", o);
  const sib = graph.siblings(viewer).find((s) => s.id === other);
  if (sib) return `${sib.half ? "half-" : ""}${word("sibling", o)}`;
  const partner = graph.partners(viewer).find((p) => p.id === other);
  if (partner) return partner.union.type === "married" ? word("partner", o) : "partner";
  if (graph.grandparents(viewer).some((g) => g.id === other)) return word("grandparent", o);
  if (graph.grandparents(other).some((g) => g.id === viewer)) return word("grandchild", o);
  // aunt or uncle: a sibling of one of the viewer's parents; niece or nephew is the reverse.
  if (graph.parents(viewer).some((p) => graph.siblings(p.id).some((s) => s.id === other))) return word("uncle", o);
  if (graph.parents(other).some((p) => graph.siblings(p.id).some((s) => s.id === viewer))) return word("nibling", o);
  // first cousin: the children of the viewer's aunts and uncles (a shared grandparent, not a shared parent).
  const mine = new Set(graph.grandparents(viewer).map((g) => g.id));
  const theirs = graph.grandparents(other);
  if (mine.size && theirs.some((g) => mine.has(g.id)) && !graph.siblings(viewer).some((s) => s.id === other)) return "cousin";
  return null;
}
