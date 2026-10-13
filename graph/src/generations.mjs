// The generation index (viz.md section 5.4, VIZ-D8; task viz-generation-index). Pure and deterministic: the same people and
// unions, in any order, give the same components, generations and levels.
//
//   1. components over partner and parent links (union membership), ids by size descending, ties by the smallest gramps id;
//   2. a parent DAG where every child ref counts, whatever its rel (a step-child still sits one generation down);
//   3. a Kahn sort: whatever is left over sits on or below an ancestor cycle (a data error) and gets generation null, and its
//      ids go to the caller as GRAPH_CYCLE for the local report;
//   4. longest path: g = 0 without parents, else 1 + the highest parent;
//   5. partner alignment: a partner with no parents takes the highest generation of its partners, then descendants are
//      re-propagated; values only rise and the loop stops after |people| rounds at most;
//   6. each component is shifted so its oldest generation is 0, and 7. its levels are listed by (birthYear ?? 9999, id).

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

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
    const members = [...u.partners, ...u.children.map((c) => c.id)].filter((id) => parent.has(id));
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

/**
 * @param {{ id: string, birthYear?: number|null }[]} people
 * @param {{ partners: string[], children: { id: string }[] }[]} unions
 * @returns {{
 *   components: { id: number, size: number, roots: string[] }[],
 *   of: Map<string, number>,
 *   generation: Map<string, number|null>,
 *   generations: { component: number, levels: string[][] }[],
 *   cycle: string[],
 * }}
 */
export function computeGenerations(people, unions) {
  const { components, of } = computeComponents(people, unions);
  const ids = people.map((p) => p.id).sort(cmp);
  const known = new Set(ids);

  // 2. parent DAG (deduplicated; refs to people outside the list are ignored)
  const childrenOf = new Map(ids.map((id) => [id, new Set()]));
  const parentsOf = new Map(ids.map((id) => [id, new Set()]));
  const partnersOf = new Map(ids.map((id) => [id, new Set()]));
  for (const u of unions) {
    const partners = u.partners.filter((id) => known.has(id));
    for (const a of partners) for (const b of partners) if (a !== b) partnersOf.get(a).add(b);
    for (const c of u.children) {
      if (!known.has(c.id)) continue;
      for (const p of partners) {
        childrenOf.get(p).add(c.id);
        parentsOf.get(c.id).add(p);
      }
    }
  }
  const sortedChildren = new Map(ids.map((id) => [id, [...childrenOf.get(id)].sort(cmp)]));

  // 3. Kahn: what never reaches in-degree 0 is on or below a cycle
  const indegree = new Map(ids.map((id) => [id, parentsOf.get(id).size]));
  const order = ids.filter((id) => indegree.get(id) === 0);
  for (let i = 0; i < order.length; i++) {
    for (const c of sortedChildren.get(order[i])) {
      indegree.set(c, indegree.get(c) - 1);
      if (indegree.get(c) === 0) order.push(c);
    }
  }
  const placed = new Set(order);
  const cycle = ids.filter((id) => !placed.has(id));

  // 4. longest path, then 5. partner alignment for the parentless, re-propagating after each round
  const g = new Map(order.map((id) => [id, 0]));
  const propagate = () => {
    for (const v of order) {
      const ps = parentsOf.get(v);
      if (ps.size) g.set(v, 1 + Math.max(...[...ps].map((p) => g.get(p))));
    }
  };
  propagate();
  const parentless = order.filter((id) => parentsOf.get(id).size === 0 && partnersOf.get(id).size > 0);
  for (let round = 0; round < ids.length; round++) {
    let changed = false;
    for (const v of parentless) {
      let best = g.get(v);
      for (const p of partnersOf.get(v)) if (g.has(p) && g.get(p) > best) best = g.get(p);
      if (best > g.get(v)) {
        g.set(v, best);
        changed = true;
      }
    }
    if (!changed) break;
    propagate();
  }

  // 6. normalize each component to 0, and 7. list its levels
  const birth = new Map(people.map((p) => [p.id, p.birthYear ?? 9999]));
  const min = new Map();
  for (const [id, v] of g) {
    const c = of.get(id);
    if (!min.has(c) || v < min.get(c)) min.set(c, v);
  }
  const generation = new Map(ids.map((id) => [id, g.has(id) ? g.get(id) - min.get(of.get(id)) : null]));
  const generations = components.map((c) => ({ component: c.id, levels: [] }));
  for (const id of ids) {
    const v = generation.get(id);
    if (v === null) continue;
    const levels = generations[of.get(id)].levels;
    while (levels.length <= v) levels.push([]);
    levels[v].push(id);
  }
  for (const entry of generations) {
    for (const level of entry.levels) level.sort((a, b) => birth.get(a) - birth.get(b) || cmp(a, b));
  }
  return { components, of, generation, generations, cycle };
}
