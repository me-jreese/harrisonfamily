// The lifelines model for /tree/ (HFY-TSK-269, viz-v2-time, flag familyVizTime; viz ADR sections 4.3 and 9.2, BRD2 R-22). Pure functions over a
// FamilyGraph: no DOM and no network, so tests/lifelines-model.test.mjs runs them in node on synthetic graphs. lib/tree-lifelines.jsx draws the
// result as our own SVG; there is no d3-scale (the one linear scale is `xOf` below) and d3-shape is not needed for straight lines.
//
//   buildLifelines(graph, focus, {maxLines, today})  ->  {rows, unions, axis, lineCount}
//
// What a row shows (graph v1 carries a birth year, a death year, one `yearApprox` flag and `living`; it carries no union id on events and no
// union year, so a marriage year is never used):
//   line   a birth year and a death year (the death year is always null for a living person)
//   ongoing a living person with a birth year: the line runs to `today` and the end is solid (the future is not drawn)
//   dot    a person with exactly one known year: a one-event person is a dot
//   none   no known year: a row with the name and "years unknown", and no mark
// Uncertain ends fade (the TimeNets encoding): `yearApprox` fades the start and the end of a line; a dot is a hollow dot. The years are in words
// on the button ("about 1880 to 1950"), so the fade is never the only cue.
//
// Unions. A union's year is the BIRTH YEAR OF ITS FIRST CHILD (min over all the union's children with a birth year, shown or not), read as
// "about": partners converge there, and children start from it. A union with no dated child has no year and draws no convergence at all. A person
// in two unions has two markers, each at its own first child (ADR section 11 item 11, section 6 deferred: the marriage-year rule waits for an
// additive union year).
//
// The 40-line cap (ADR 4.3). The view holds the focus person, their parents, and their descendants with the partners that make the unions,
// breadth first, until `maxLines` lines are placed. A family that does not fit collapses into a "+N more in <name>'s family" row (a button that
// re-centres on that person), so a branch is never silently dropped. Collapse rows are not lines; every collapsed family gets one, and its N is
// everyone hidden under it, so nothing is dropped and nothing is undercounted. Every shown person is still a button that opens the navigator on them.
//
// Decades only: the axis is whole decades; no era band exists in this task (viz-v2-time-eras, Q2-14).

export const MAX_LINES = 40;

const isNum = (n) => typeof n === "number" && Number.isFinite(n);

/** The mark one person draws: {kind: "line"|"dot"|"none", start, end, ongoing, fuzzy}. Years are integers; `fuzzy` fades the ends. */
export function markOf(p, today) {
  const b = isNum(p.birthYear) ? p.birthYear : null;
  const d = p.living ? null : isNum(p.deathYear) ? p.deathYear : null;
  const fuzzy = p.yearApprox === true;
  if (p.living) {
    if (b === null) return { kind: "none", fuzzy: false };
    // A birth year in the future of `today` (bad data) is a dot rather than a backwards line.
    return b < today ? { kind: "line", start: b, end: today, ongoing: true, fuzzy } : { kind: "dot", start: b, end: b, ongoing: false, fuzzy };
  }
  if (b !== null && d !== null) return d > b ? { kind: "line", start: b, end: d, ongoing: false, fuzzy } : { kind: "dot", start: b, end: b, ongoing: false, fuzzy };
  const only = b ?? d;
  if (only !== null) return { kind: "dot", start: only, end: only, ongoing: false, fuzzy: b !== null && fuzzy };
  return { kind: "none", fuzzy: false };
}

/** The union's year: the earliest birth year among all its children, or null (no dated child: nothing converges). */
export function unionYear(graph, union) {
  let year = null;
  for (const c of union.children || []) {
    const p = graph.person(c.id);
    if (p && isNum(p.birthYear) && (year === null || p.birthYear < year)) year = p.birthYear;
  }
  return year;
}

/** The person's unions, earliest first-child first (undated last, then the graph's own order), with the year of each. */
function orderedUnions(graph, id) {
  const list = graph.unionsOf(id).map((u, i) => ({ ...u, year: unionYear(graph, u.union), i }));
  return list.sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity) || a.i - b.i);
}

/** The unions of `parentId` that `childId` belongs to, as orderedUnions entries. */
const unionsWithChild = (graph, parentId, childId) => orderedUnions(graph, parentId).filter((u) => u.children.some((c) => c.id === childId));

/**
 * @param graph  a FamilyGraph
 * @param focus  the person whose family the view shows
 * @returns {{rows, unions, axis, lineCount, focus}}
 *   rows[]    {type: "line", id, name, depth, mark, years} or {type: "more", id, name, count, depth}   (display order)
 *   unions[]  {key, year, from, to, nodes: [row index], kids: [row index]}   drawn only when `year` is known
 *   axis      {min, max, ticks: [{year, label}]} in whole decades, or null when no row has a year
 */
export function buildLifelines(graph, focus, { maxLines = MAX_LINES, today = new Date().getFullYear() } = {}) {
  if (!graph.has(focus)) return { rows: [], unions: [], axis: null, lineCount: 0, focus: null };

  // Phase 1: who is shown (breadth first, so the nearest family wins the budget) and which families collapse.
  const shown = new Set();
  const add = (id) => {
    if (shown.has(id)) return true;
    if (shown.size >= maxLines) return false;
    shown.add(id);
    return true;
  };
  const parentIds = graph.parents(focus).map((p) => p.id).slice(0, 2);
  for (const id of parentIds) add(id);
  add(focus);
  const hiddenRoots = new Map(); // person id -> the partners and children of their unions that did not fit
  const queue = [focus];
  while (queue.length) {
    const x = queue.shift();
    const roots = [];
    for (const u of orderedUnions(graph, x)) {
      if (u.partner && !shown.has(u.partner) && !add(u.partner)) roots.push(u.partner);
      for (const c of u.children) {
        if (shown.has(c.id)) continue;
        if (add(c.id)) queue.push(c.id); else roots.push(c.id);
      }
    }
    if (roots.length) hiddenRoots.set(x, roots);
  }
  // N counts everyone hidden under the branch: each hidden partner or child and all they lead to (their partners and descendants), each person once,
  // credited to the first branch (breadth first) that reaches them. So the shown lines plus every N are the people reachable from the focus.
  const claimed = new Set();
  const collapsed = new Map(); // person id -> how many people of their family are not shown
  for (const [x, roots] of hiddenRoots) {
    let n = 0;
    const stack = [...roots];
    while (stack.length) {
      const id = stack.pop();
      if (shown.has(id) || claimed.has(id) || !graph.has(id)) continue;
      claimed.add(id);
      n += 1;
      for (const u of graph.unionsOf(id)) {
        if (u.partner) stack.push(u.partner);
        for (const c of u.children) stack.push(c.id);
      }
    }
    if (n) collapsed.set(x, n);
  }

  // Phase 2: depth first, so a family reads together: the person, then each union's partner and children (and theirs).
  const rows = [];
  const unions = [];
  const emitted = new Set();
  const lineRow = (id, depth) => {
    emitted.add(id);
    const p = graph.person(id);
    rows.push({ type: "line", id, name: p.name, depth, mark: markOf(p, today), person: p });
    return rows.length - 1;
  };
  const emit = (id, depth) => {
    const own = lineRow(id, depth);
    for (const u of orderedUnions(graph, id)) {
      const nodes = [own];
      if (u.partner && shown.has(u.partner) && !emitted.has(u.partner)) nodes.push(lineRow(u.partner, depth));
      else if (u.partner && emitted.has(u.partner)) nodes.push(rows.findIndex((r) => r.id === u.partner));
      const kids = [];
      for (const c of u.children) {
        if (!shown.has(c.id) || emitted.has(c.id)) continue;
        kids.push(emit(c.id, depth + 1));
      }
      const from = Math.min(...nodes);
      const to = Math.max(...nodes, ...kids);
      if (u.year !== null && to > from) unions.push({ key: u.union.id, year: u.year, from, to, nodes, kids });
    }
    if (collapsed.has(id)) rows.push({ type: "more", id, name: graph.person(id).name, count: collapsed.get(id), depth: depth + 1 });
    return own;
  };

  const shownParents = parentIds.filter((id) => shown.has(id));
  const parentRows = shownParents.map((id) => lineRow(id, 0));
  const focusRow = emit(focus, shownParents.length ? 1 : 0);
  // The parents' unions: partners converge at the first child's birth year (a brother or sister may be the first), and the focus person starts there.
  const seen = new Set();
  for (const pid of shownParents) {
    for (const u of unionsWithChild(graph, pid, focus)) {
      if (seen.has(u.union.id)) continue;
      seen.add(u.union.id);
      const nodes = u.union.partners.map((x) => parentRows[shownParents.indexOf(x)]).filter((n) => n !== undefined);
      if (u.year !== null && nodes.length) unions.push({ key: u.union.id, year: u.year, from: Math.min(...nodes), to: focusRow, nodes, kids: [focusRow] });
    }
  }

  const lineRows = rows.filter((r) => r.type === "line");
  return { rows, unions, axis: axisOf(rows, unions, today), lineCount: lineRows.length, focus };
}

/** The decades axis: whole decades from the earliest year to the latest (today for a living person), a label every few decades. */
export function axisOf(rows, unions, today) {
  const years = [];
  for (const r of rows) if (r.type === "line" && r.mark.kind !== "none") years.push(r.mark.start, r.mark.end);
  for (const u of unions) years.push(u.year);
  if (!years.length) return null;
  const min = Math.floor(Math.min(...years) / 10) * 10;
  let max = Math.ceil(Math.max(...years) / 10) * 10;
  if (max <= min) max = min + 10;
  const decades = (max - min) / 10;
  const every = Math.max(1, Math.ceil((decades + 1) / 11));
  const ticks = [];
  for (let i = 0; i <= decades; i += 1) ticks.push({ year: min + i * 10, label: i % every === 0 ? String(min + i * 10) : null });
  return { min, max, ticks };
}

/** The one linear scale: a year to a percentage of the lane, inset so a dot at the edge is not clipped. */
export const LANE_PAD = 3;
export function xOf(axis, year) {
  return LANE_PAD + ((year - axis.min) / (axis.max - axis.min)) * (100 - 2 * LANE_PAD);
}

/** The line's fade, in lane percentage points at each fuzzy end: a tenth of the span, between one and a decade's width. */
export function fadeWidth(axis, mark) {
  const decade = (10 / (axis.max - axis.min)) * (100 - 2 * LANE_PAD);
  const span = xOf(axis, mark.end) - xOf(axis, mark.start);
  return Math.min(decade, span / 3);
}
