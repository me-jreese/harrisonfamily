// The whole-family poster's pure model (HFY-TSK-272, viz-v2-bigtree, flag familyVizBigTree; viz ADR sections 4.5 and 4.7, task AC 1 to 4).
// No DOM and no network, so tests/bigtree-model.test.mjs runs it in node on the synthetic tests/fixtures/tree-graph-poster.json.
//
// The `layout` block of graph.json (minor 2, built by graph/ with d3-dag at build time) holds the coordinates: this file only reads them.
// There is no layout code here and no d3-dag in any island bundle (tests/bundle.test.mjs). Per component, people and unions have integer
// centre points; `bends` are the intermediate points of a link that spans more than one layer. A person appears once in the block, so a
// pedigree-collapsed ancestor appears once on the poster; the badge says the other ways the viewer descends from them (relationPaths).
import { faceUrl, initials } from "./navigator-model.js";
import { yearsLabel } from "./tree-data.js";

/** The smallest size a name is ever drawn at, in screen pixels (task AC 3; the people who read this site read it on a wide screen). */
export const MIN_NAME_PX = 16;
/** The name's font size in the layout's own units. At scale 1 (one unit is one pixel) it is drawn at exactly MIN_NAME_PX. */
export const NAME_UNITS = 16;
export const DEFAULT_NODE = [180, 90];
/** The card's gap to its neighbours, in layout units. */
export const CARD_GAP = 20;
/** The union connector's radius, in layout units. */
export const UNION_R = 6;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const validPoint = (n) => isObj(n) && typeof n.id === "string" && isNum(n.x) && isNum(n.y);

/**
 * The usable layout block of a graph, or null (absent, or not the shape the builder writes). A bad block reads as an absent one: the view then
 * says it is being prepared rather than drawing half a poster.
 */
export function layoutOf(graph) {
  const l = graph?.data?.layout;
  if (!isObj(l) || !Array.isArray(l.components) || !l.components.length) return null;
  const ns = Array.isArray(l.params?.nodeSize) && l.params.nodeSize.length === 2 && l.params.nodeSize.every((n) => isNum(n) && n > 0) ? l.params.nodeSize : DEFAULT_NODE;
  const components = [];
  for (const c of l.components) {
    if (!isObj(c) || !isNum(c.width) || !isNum(c.height) || c.width <= 0 || c.height <= 0 || !Array.isArray(c.people)) return null;
    const people = c.people.filter(validPoint);
    if (!people.length) continue;
    components.push({
      component: c.component,
      width: c.width,
      height: c.height,
      people,
      unions: (Array.isArray(c.unions) ? c.unions : []).filter(validPoint),
      bends: (Array.isArray(c.bends) ? c.bends : []).filter((b) => isObj(b) && typeof b.s === "string" && typeof b.t === "string" && Array.isArray(b.points) && b.points.every((p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1])))
    });
  }
  return components.length ? { nodeSize: ns, components } : null;
}

/** Whether a name is drawn at this scale (screen pixels per layout unit): never when it would be smaller than MIN_NAME_PX. */
export const showsName = (scale) => isNum(scale) && NAME_UNITS * scale >= MIN_NAME_PX;

/**
 * An elbow through `points` ([[x, y], ...], source first): down to half way, across, down again, segment by segment, so a link with bend
 * points follows the layers the builder routed it through.
 */
export function elbowPath(points) {
  let d = `M${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length; i += 1) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    if (x1 === x2) d += ` V${y2}`;
    else {
      const mid = Math.round((y1 + y2) / 2);
      d += ` V${mid} H${x2} V${y2}`;
    }
  }
  return d;
}

/** Break a name over at most two lines of `max` characters, ending the second with an ellipsis. The whole name stays in the accessible name. */
export function nameLines(name, max = 16) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines = [""];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if (!cur) lines[lines.length - 1] = w;
    else if ((cur + " " + w).length <= max) lines[lines.length - 1] = `${cur} ${w}`;
    else lines.push(w);
  }
  const clip = (s) => ([...s].length > max ? `${[...s].slice(0, max - 1).join("")}…` : s);
  if (lines.length > 2) lines.splice(1, lines.length - 1, lines.slice(1).join(" "));
  return lines.map(clip);
}

/**
 * Where else the viewer descends from `id`: one entry per extra route, `{through}` being the first person on that route who is not on the
 * main one. Empty when `id` is not an ancestor of the viewer, or only one route reaches them.
 */
export function collapseRoutes(graph, viewer, id) {
  if (!viewer || viewer === id || !graph.has(viewer)) return [];
  const paths = graph.relationPaths(viewer, id).filter((p) => p.kind === "blood" && p.ancestor === id && p.down.length === 1);
  if (paths.length < 2) return [];
  const main = paths[0].up;
  const out = [];
  const seen = new Set();
  for (const p of paths.slice(1)) {
    let k = 1;
    while (k < p.up.length - 1 && p.up[k] === main[k]) k += 1;
    const through = p.up[k];
    if (through === id || seen.has(through)) continue;
    seen.add(through);
    out.push({ through });
  }
  return out;
}

const listWords = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** "also your ancestor through Wes Fenn", or null. */
export function badgeSentence(graph, routes) {
  const names = routes.map((r) => graph.person(r.through)?.name).filter(Boolean);
  return names.length ? `also your ancestor through ${listWords(names)}` : null;
}

/**
 * The poster, ready to draw: `null` without a usable layout block, else
 *   {nodeSize, card: [w, h], components: [{index, width, height, people: [card], unions: [{id, x, y}], links: [{key, d}]}], notShown}
 * where a card is {id, name, lines, initials, face, years, x, y, label, badge}. `label` is the accessible name and the hover or focus label:
 * "Name, 1900 to 1970, also your ancestor through ...". `notShown` counts the people the block leaves out (a person with no recorded kin).
 */
export function posterModel(graph, viewer = null) {
  const layout = layoutOf(graph);
  if (!layout) return null;
  const [nw, nh] = layout.nodeSize;
  const unionsById = new Map(graph.data.unions.filter(isObj).map((u) => [u.id, u]));
  let drawn = 0;
  const components = layout.components.map((c, index) => {
    const pos = new Map();
    const people = [];
    for (const p of c.people) {
      const person = graph.person(p.id);
      if (!person || pos.has(p.id)) continue;
      pos.set(p.id, p);
      drawn += 1;
      const badge = badgeSentence(graph, collapseRoutes(graph, viewer, p.id));
      const years = yearsLabel(person);
      people.push({
        id: p.id, name: person.name, lines: nameLines(person.name), initials: initials(person), face: faceUrl(person.face), years,
        x: p.x, y: p.y, badge, label: [person.name, years, badge].filter(Boolean).join(", ")
      });
    }
    const unions = c.unions.filter((u) => unionsById.has(u.id));
    const upos = new Map(unions.map((u) => [u.id, u]));
    const bends = new Map(c.bends.map((b) => [`${b.s}>${b.t}`, b.points]));
    const link = (s, t, from, to) => {
      const via = bends.get(`${s}>${t}`) || bends.get(`${t}>${s}`) || [];
      const mid = bends.has(`${s}>${t}`) ? via : [...via].reverse();
      return { key: `${s}>${t}`, d: elbowPath([from, ...mid, to]) };
    };
    const links = [];
    for (const u of unions) {
      const src = unionsById.get(u.id);
      for (const pid of src.partners || []) {
        const p = pos.get(pid);
        if (p) links.push(link(pid, u.id, [p.x, p.y + (nh - CARD_GAP) / 2], [u.x, u.y - UNION_R]));
      }
      for (const ch of src.children || []) {
        const p = pos.get(ch.id);
        if (p) links.push(link(u.id, ch.id, [u.x, u.y + UNION_R], [p.x, p.y - (nh - CARD_GAP) / 2]));
      }
    }
    return { index, width: c.width, height: c.height, people, unions: [...upos.values()], links };
  }).filter((c) => c.people.length);
  return { nodeSize: [nw, nh], card: [nw - CARD_GAP, nh - CARD_GAP], components, notShown: Math.max(0, graph.size - drawn) };
}
