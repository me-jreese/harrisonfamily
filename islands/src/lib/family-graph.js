// The family graph for the /tree/ page (viz domain, HFY-TSK-201; design viz.md sections 5.3 and 8). Pure functions and one class, no DOM and no
// network, so tests/family-graph.test.mjs runs them in node on synthetic graphs.
//
//   parseGraph(json)                    check the version and the shape; returns a FamilyGraph (throws GraphError)
//   new FamilyGraph(data)               person, parents, unionsOf, siblings, grandparents, relativeGeneration, neighborhood, levels
//   graph.relationPaths(a, b)           every shortest path between two people through common ancestors, over parent and partner links
//   relationLabel(graph, viewer, other) the kinship namer ("mother", "half-sister", "second cousin once removed", "sister-in-law"); null only
//                                       when an id is not in the graph (HFY-TSK-270, the kinship engine; pure logic, no flag)
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
        const shared = [...myParents].filter((p) => theirs.has(p)).length;
        // Half only when both people have two recorded parents and share exactly one; with a parent unrecorded the data cannot tell.
        out.set(c.id, { id: c.id, half: myParents.size === 2 && theirs.size === 2 && shared === 1 });
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

  /** Every shortest path from `a` to `b` through a common ancestor, over parent links, plus one partner hop when that is shorter (or the only
   *  way): [{kind, nodes, length, ...}] ordered most direct first; [] when the two are not connected or an id is not in the graph. kind:
   *    "blood"   {ancestor, up:[a..ancestor], down:[ancestor..b]}   a to the ancestor and down to b (ancestor may be a or b)
   *    "partner" {side, partner, blood}  side "direct" (a and b are partners), "a" (a's partner `partner` is related to b by `blood`) or
   *              "b" (b's partner `partner` is related to a by `blood`)
   *  nodes is the whole chain of ids from a to b; length counts its links. Capped at 64 paths. */
  relationPaths(a, b) {
    return relationPaths(this, a, b);
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

/** The plain role word for a kind of relative and a person's sex ("mother", "son", "aunt or uncle"). */
export const roleWord = word;

// ---- the kinship engine (HFY-TSK-270) ----

const MAX_PATHS = 64;
const CHAINS_PER_SIDE = 8;

const parentCache = new WeakMap();
/** graph.parents(id), memoised per graph (a FamilyGraph is immutable once built). */
function parentsOf(graph, id) {
  let m = parentCache.get(graph);
  if (!m) { m = new Map(); parentCache.set(graph, m); }
  let v = m.get(id);
  if (!v) { v = graph.parents(id); m.set(id, v); }
  return v;
}

/** Breadth-first over parent links from `id`: dist (id -> generations up) and kids (id -> the nodes one step closer to `id` that reach it). */
function ancestry(graph, id, cache) {
  const hit = cache.get(id);
  if (hit) return hit;
  const dist = new Map([[id, 0]]);
  const kids = new Map();
  let level = [id];
  for (let d = 0; level.length; d += 1) {
    const next = [];
    for (const n of level) {
      for (const p of parentsOf(graph, n)) {
        if (!dist.has(p.id)) { dist.set(p.id, d + 1); kids.set(p.id, [n]); next.push(p.id); }
        else if (dist.get(p.id) === d + 1) kids.get(p.id).push(n);
      }
    }
    level = next;
  }
  const out = { dist, kids };
  cache.set(id, out);
  return out;
}

/** Every chain [start .. c] of shortest parent steps, at most `cap`. */
function chains(anc, c, cap) {
  if (anc.dist.get(c) === 0) return [[c]];
  const out = [];
  for (const k of anc.kids.get(c) || []) {
    for (const sub of chains(anc, k, cap - out.length)) { out.push([...sub, c]); if (out.length >= cap) return out; }
  }
  return out;
}

/** The shortest blood paths a -> b through a common ancestor: {length, paths}. */
function bloodPaths(graph, a, b, cache) {
  const A = ancestry(graph, a, cache);
  const B = ancestry(graph, b, cache);
  let best = Infinity;
  let commons = [];
  for (const [c, da] of A.dist) {
    const db = B.dist.get(c);
    if (db === undefined) continue;
    if (da + db < best) { best = da + db; commons = [c]; } else if (da + db === best) commons.push(c);
  }
  const paths = [];
  for (const c of commons) {
    for (const up of chains(A, c, CHAINS_PER_SIDE)) {
      for (const downRev of chains(B, c, CHAINS_PER_SIDE)) {
        const down = [...downRev].reverse();
        paths.push({ kind: "blood", ancestor: c, up, down, nodes: [...up, ...down.slice(1)], length: best });
        if (paths.length >= MAX_PATHS) break;
      }
      if (paths.length >= MAX_PATHS) break;
    }
    if (paths.length >= MAX_PATHS) break;
  }
  // Tie-break (documented rule): among equal-length paths the label comes from the first, which is the most balanced one (smaller longer side,
  // so a (2,2) split reads "first cousin" ahead of a (1,3) split), then the shorter upward leg, then the ancestor id for stability.
  // Most direct first: the smaller longer side, then the shorter upward leg, then the ancestor id (stable).
  paths.sort((x, y) => Math.max(x.up.length, x.down.length) - Math.max(y.up.length, y.down.length) || x.up.length - y.up.length || (x.ancestor < y.ancestor ? -1 : x.ancestor > y.ancestor ? 1 : 0));
  return { length: best, paths };
}

const KIND_RANK = { blood: 0, "partner:direct": 1, "partner:mid": 2, "partner:b": 3, "partner:a": 4 };
const rankOf = (p) => KIND_RANK[p.kind === "blood" ? "blood" : `partner:${p.side}`];

/** Every shortest path a -> b over parent and partner links (see FamilyGraph#relationPaths). */
export function relationPaths(graph, a, b) {
  if (!graph.has(a) || !graph.has(b)) return [];
  if (a === b) return [{ kind: "blood", ancestor: a, up: [a], down: [a], nodes: [a], length: 0 }];
  const cands = [];
  const cache = new Map();
  const blood = bloodPaths(graph, a, b, cache);
  cands.push(...blood.paths);
  if (graph.partners(a).some((p) => p.id === b)) cands.push({ kind: "partner", side: "direct", partner: b, blood: null, nodes: [a, b], length: 1 });
  const bridge = blood.length > 2;
  for (const pa of bridge ? graph.partners(a) : []) {
    if (pa.id === b) continue;
    const bp = bloodPaths(graph, pa.id, b, cache);
    for (const path of bp.paths) cands.push({ kind: "partner", side: "a", partner: pa.id, blood: path, nodes: [a, ...path.nodes], length: bp.length + 1 });
  }
  for (const pb of bridge ? graph.partners(b) : []) {
    if (pb.id === a) continue;
    const bp = bloodPaths(graph, a, pb.id, cache);
    for (const path of bp.paths) cands.push({ kind: "partner", side: "b", partner: pb.id, blood: path, nodes: [...path.nodes, b], length: bp.length + 1 });
  }
  if (bridge) {
    // A partner hop in the middle: `b` is a child of a parent's partner (a step-sibling), a -> parent -> parent's partner -> b.
    for (const par of graph.parents(a)) {
      for (const q of graph.partners(par.id)) {
        if (q.id === a || q.id === b || graph.parents(a).some((x) => x.id === q.id)) continue;
        if (graph.children(q.id).some((c) => c.id === b)) cands.push({ kind: "partner", side: "mid", partner: q.id, blood: null, nodes: [a, par.id, q.id, b], length: 3 });
      }
    }
  }
  if (!cands.length) return [];
  const min = Math.min(...cands.map((c) => c.length));
  return cands.filter((c) => c.length === min).sort((x, y) => rankOf(x) - rankOf(y)).slice(0, MAX_PATHS);
}

const ORDINALS = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const ordinal = (n) => {
  if (ORDINALS[n]) return ORDINALS[n];
  const t = n % 100;
  const suffix = t >= 11 && t <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
  return `${n}${suffix}`;
};
/** "great-" for one, "second great-" for two, and so on. */
const greats = (k) => (k <= 0 ? "" : k === 1 ? "great-" : `${ordinal(k)} great-`);

/** The blood word for `person` when `up` generations separate the viewer from the common ancestor and `down` the ancestor from the person. */
function bloodWord(up, down, person) {
  if (up === 0) return down === 1 ? word("child", person) : `${greats(down - 2)}${word("grandchild", person)}`;
  if (down === 0) return up === 1 ? word("parent", person) : `${greats(up - 2)}${word("grandparent", person)}`;
  if (up === 1 && down === 1) return word("sibling", person);
  if (up === 1) return `${greats(down - 2)}${word("nibling", person)}`;
  if (down === 1) return `${greats(up - 2)}${word("uncle", person)}`;
  const degree = Math.min(up, down) - 1;
  const removed = Math.abs(up - down);
  const tail = removed === 0 ? "" : removed === 1 ? " once removed" : removed === 2 ? " twice removed" : ` ${removed} times removed`;
  return `${ordinal(degree)} cousin${tail}`;
}

const legs = (path) => ({ up: path.up.length - 1, down: path.down.length - 1 });

/** Shown when the two people sit in different components (or one has no place in the tree yet); never compared by generation. */
export const NOT_CONNECTED = "not yet connected";
/** Shown when both are in the tree but no path of parents and partners joins them. */
export const NOT_RELATED = "not related";
/** True for a label that names a real relationship (the focus card writes "your <label>" only for these). */
export const isRelationWord = (label) => typeof label === "string" && label !== "you" && label !== NOT_CONNECTED && label !== NOT_RELATED && label !== RELATED_BY_MARRIAGE;

/** Shown when two people are joined only by a chain of parent and partner links longer than the engine labels (a step-sibling's spouse, say). */
export const RELATED_BY_MARRIAGE = "related by marriage";

/** True when any chain of parent, child and partner links joins the two people (plain BFS). */
function linked(graph, a, b) {
  const seen = new Set([a]);
  const queue = [a];
  while (queue.length) {
    const id = queue.shift();
    if (id === b) return true;
    for (const n of [...graph.parents(id), ...graph.children(id), ...graph.partners(id)]) if (!seen.has(n.id)) { seen.add(n.id); queue.push(n.id); }
  }
  return false;
}

/** What `other` is to `viewer` ("mother", "half-sister", "great-aunt", "second cousin once removed", "stepmother", "sister-in-law",
 *  "adopted son"). Lowercase words, never derived from colour. "you" for the same person; NOT_CONNECTED across components or for someone with
 *  no place in the tree; NOT_RELATED when no path joins two connected people; null only when an id is not in the graph. */
export function relationLabel(graph, viewer, other) {
  if (!graph.has(viewer) || !graph.has(other)) return null;
  if (viewer === other) return "you";
  const v = graph.person(viewer);
  const o = graph.person(other);
  const placed = (p) => Number.isInteger(p.generation) && p.component !== undefined && p.component !== null;
  if (!placed(v) || !placed(o) || v.component !== o.component) {
    // Without component data (a bare graph) a path may still exist; otherwise the pair is not yet connected.
    if (!(v.component === undefined && o.component === undefined)) return NOT_CONNECTED;
  }
  const path = graph.relationPaths(viewer, other)[0];
  if (!path) {
    if (!(placed(v) && placed(o))) return NOT_CONNECTED;
    // A longer chain of parent and partner links still joins them: neutral, not "not related".
    return linked(graph, viewer, other) ? RELATED_BY_MARRIAGE : NOT_RELATED;
  }
  if (path.kind === "blood") return directLabel(graph, viewer, other, path, o);
  if (path.side === "mid") return { f: "stepsister", m: "stepbrother" }[o.sex] || "stepsibling";
  if (path.side === "direct") {
    const partner = graph.partners(viewer).find((p) => p.id === other);
    return partner && partner.union.type === "married" ? word("partner", o) : "partner";
  }
  const { up, down } = legs(path.blood);
  if (path.side === "b") {
    // `other` is the partner of someone who is the viewer's relative.
    if (down === 0) return up === 1 ? { f: "stepmother", m: "stepfather" }[o.sex] || "stepparent" : `step-${bloodWord(up, down, o)}`;
    if (up === 0) return `${bloodWord(up, down, o)}-in-law`;
    if (up === 1 && down === 1) return `${word("sibling", o)}-in-law`;
    return `${bloodWord(up, down, o)} by marriage`;
  }
  // side "a": `other` is a relative of the viewer's partner.
  if (down === 0) return `${bloodWord(up, down, o)}-in-law`;
  if (up === 0) return down === 1 ? { f: "stepdaughter", m: "stepson" }[o.sex] || "stepchild" : `step-${bloodWord(up, down, o)}`;
  if (up === 1 && down === 1) return `${word("sibling", o)}-in-law`;
  return `${bloodWord(up, down, o)} by marriage`;
}

function directLabel(graph, viewer, other, path, o) {
  const { up, down } = legs(path);
  if (up === 1 && down === 1) {
    const sib = graph.siblings(viewer).find((s) => s.id === other);
    return `${sib && sib.half ? "half-" : ""}${word("sibling", o)}`;
  }
  if (up + down === 1) {
    // Adoption shows on the single parent link: the child's side of the link says how the parent came to be one.
    const parentId = up === 1 ? other : viewer;
    const childId = up === 1 ? viewer : other;
    const link = graph.parents(childId).find((p) => p.id === parentId);
    const base = bloodWord(up, down, o);
    if (link && link.rel === "adopted") return up === 1 ? `adoptive ${base}` : `adopted ${base}`;
    return base;
  }
  return bloodWord(up, down, o);
}
