// The pure model behind the focus navigator and the generation outline (HFY-TSK-202; viz.md sections 9.4 and 12.3). No DOM, so
// tests/tree-outline.test.mjs runs it in node on the synthetic graph.
import { roleWord } from "./family-graph.js";

export const LEVEL_PAGE = 20;

const isInt = Number.isInteger;

/** The place name for a place id, or null. */
export function placeName(graph, id) {
  if (!id) return null;
  const hit = (graph.data.places || []).find((p) => p && p.id === id);
  return hit?.name || null;
}

/** "Ben Example, father": the label of a relative on the focus card. kind: parent | child | sibling | partner | grandparent. */
export function roleLabel(kind, person, { rel = null, half = false, unionType = null } = {}) {
  let w = roleWord(kind, person);
  if (kind === "partner" && unionType === "married" && w === "partner") w = "spouse";
  if (kind === "partner" && unionType !== "married") w = "partner";
  if (kind === "sibling" && half) w = `half-${w}`;
  if ((kind === "parent" || kind === "child") && (rel === "adopted" || rel === "step")) w = `${rel} ${w}`;
  return w;
}

/** The people on the focus card, grouped for rendering. Every entry is {id, name, label}. */
export function focusGroups(graph, focus) {
  const entry = (id, kind, extra) => {
    const p = graph.person(id);
    return { id, name: p.name, label: roleLabel(kind, p, extra) };
  };
  const unions = graph.unionsOf(focus).map((u, i, all) => ({
    key: u.union.id,
    title: `${u.partner ? "partner and children" : "children"}${all.length > 1 ? ` (${i + 1} of ${all.length})` : ""}`,
    partner: u.partner ? entry(u.partner, "partner", { unionType: u.union.type }) : null,
    children: u.children.map((c) => entry(c.id, "child", { rel: c.rel }))
  }));
  return {
    parents: graph.parents(focus).map((x) => entry(x.id, "parent", { rel: x.rel })),
    unions,
    siblings: graph.siblings(focus).map((x) => entry(x.id, "sibling", { half: x.half })),
    grandparents: graph.grandparents(focus).map((x) => entry(x.id, "grandparent"))
  };
}

const GREAT = (n) => (n <= 0 ? "" : n <= 3 ? "great-".repeat(n) : `${n}x great-`);

/** A level's name relative to the focus ("Ada's parents' generation"), from `delta` = level generation - focus generation. */
export function generationLabel(delta, given) {
  const who = `${given}'s`;
  if (delta === 0) return `${who} generation`;
  if (delta < 0) {
    const up = -delta;
    const w = up === 1 ? "parents'" : `${GREAT(up - 2)}grandparents'`;
    return `${who} ${w} generation`;
  }
  const w = delta === 1 ? "children's" : `${GREAT(delta - 2)}grandchildren's`;
  return `${who} ${w} generation`;
}

/**
 * The outline: the levels of one component, oldest first, and everyone else under "not yet connected".
 * The component is the focus person's when they have a generation, else component 0 (so the outline always lists the whole main tree).
 * {levels: [{index, label, ids, hasFocus}], unconnected: [ids], relative: boolean}.
 */
export function outlineModel(graph, focus) {
  const p = graph.person(focus);
  const connected = p && isInt(p.generation);
  const component = connected ? p.component : 0;
  const raw = graph.levels(component);
  const given = (p && (p.given || p.name)) || "";
  const seen = new Set();
  const levels = [];
  raw.forEach((ids, index) => {
    const live = ids.filter((id) => graph.has(id) && !seen.has(id));
    if (!live.length) return;
    live.forEach((id) => seen.add(id));
    let label;
    if (connected) label = generationLabel(index - p.generation, given);
    else label = raw.length > 1 ? `generation ${levels.length + 1} of ${raw.length}` : "generation";
    levels.push({ index, label, ids: live, hasFocus: live.includes(focus) });
  });
  const unconnected = graph.people().map((x) => x.id).filter((id) => !seen.has(id));
  return { levels, unconnected, relative: Boolean(connected) };
}
