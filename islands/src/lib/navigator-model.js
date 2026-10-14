// The pure model behind <family-navigator> and its details sheet (HFY-TSK-145, viz-mvp-visual; viz ADR section 9.1; viz.md sections 9.3, 9.4
// and 12.2). No DOM, so tests/navigator-model.test.mjs runs it in node on a messy synthetic graph.
//
//   navigatorModel(graph, focus)   what the element draws: the focus card, the parents strip, one entry per union (partner and children),
//                                  and the brothers and sisters. null when `focus` is not in the graph.
//   detailsModel(graph, id)        what the kit Sheet lists for "hfy-details": years, places, unions, children and the page link.
//   placeChain(graph, placeId)     "Riverton, Marlow County, Examplestate": the real place chain (child to parent), never a guess.
//
// A person the graph does not hold (a private-excluded person) is simply absent: FamilyGraph skips dangling ids, and this model never
// invents a card for them. A parent who is not recorded is shown as a placeholder, never as a guessed person.
import { roleLabel } from "./tree-outline.js";
import { yearsLabel } from "./tree-data.js";

export const COPY = {
  parentsNone: "parents not recorded yet",
  parentMissing: "parent not recorded",
  partnerMissing: "partner not recorded",
  childrenNone: "no children recorded yet",
  notConnected: "not yet connected to the tree",
  noUnions: "no partner or children recorded yet",
  viewPage: "view page"
};

/** Text badges for a parent link (the per-parent `rel` of graph.json v1): adopted, step and foster. Birth, sponsored, unknown, none and custom show none. */
const REL_BADGE = { adopted: "adopted", step: "step", foster: "foster" };

const MAX_PLACE_PARTS = 3;
const FACE_PATH = /^faces\/[A-Za-z0-9_-]+\.webp$/;

const placeIndexes = new WeakMap();
function placeIndex(graph) {
  let idx = placeIndexes.get(graph);
  if (!idx) {
    idx = new Map((Array.isArray(graph.data.places) ? graph.data.places : []).filter((p) => p && typeof p.id === "string").map((p) => [p.id, p]));
    placeIndexes.set(graph, idx);
  }
  return idx;
}

/** The place chain for a place id, leaf first ("Riverton, Marlow County, Examplestate"), at most three parts; null for no place or a dangling id. */
export function placeChain(graph, id) {
  if (!id) return null;
  const idx = placeIndex(graph);
  const parts = [];
  const seen = new Set();
  let cur = idx.get(id);
  while (cur && parts.length < MAX_PLACE_PARTS && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (typeof cur.name === "string" && cur.name) parts.push(cur.name);
    cur = cur.parent ? idx.get(cur.parent) : null;
  }
  return parts.length ? parts.join(", ") : null;
}

/** "born in Riverton, Examplestate", else "died in ...", else null. A living person has no place line (the same rule as the focus list). */
export function placeLine(graph, p) {
  if (p.living) return null;
  const born = placeChain(graph, p.birthPlace);
  if (born) return `born in ${born}`;
  const died = placeChain(graph, p.deathPlace);
  return died ? `died in ${died}` : null;
}

/** The served URL of a face crop, or null. Only the builder's own file names are accepted: anything else is initials, never a guessed crop. */
export function faceUrl(face) {
  return typeof face === "string" && FACE_PATH.test(face) ? `/media/${face}` : null;
}

/** Up to two letters for the initials avatar: the given name and surname, else the first and last word of the name. */
export function initials(p) {
  const first = String(p.given || "").trim();
  const last = String(p.surname || "").trim();
  let letters;
  if (first && last) letters = [first, last];
  else {
    const words = String(p.name || "").trim().split(/\s+/).filter(Boolean);
    letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  }
  return letters.map((w) => [...w][0]).join("").toUpperCase() || "?";
}

/**
 * One person card. kind: "focus" | "parent" | "child" | "sibling" | "partner". `rel` is the per-parent link for a parent or a child of the
 * focus; `half` marks a half-sibling; `unionType` names a partner's word (wife, husband, spouse, partner).
 * `label` is the accessible name ("Ben Example, father, 1878 to unknown"); `role` is the plain role word shown on the card. The focus card is an
 * action (it opens the details sheet), so its name reads "Ada Example, focus, 1878 to unknown, show details" and it shows no role word.
 */
export function personCard(graph, id, kind, { rel = null, half = false, unionType = null, withPlace = false } = {}) {
  const p = graph.person(id);
  const years = yearsLabel(p);
  const badges = [];
  const relBadge = kind === "parent" || kind === "child" ? REL_BADGE[rel] || null : null;
  if (relBadge) badges.push(relBadge);
  if (kind === "sibling" && half) badges.push("half-sibling");
  const card = {
    id,
    name: p.name,
    kind,
    initials: initials(p),
    face: faceUrl(p.face),
    years,
    place: withPlace ? placeLine(graph, p) : null,
    badges,
    role: null,
    label: null
  };
  if (kind === "focus") {
    card.label = `${p.name}, focus, ${years}, show details`;
    return card;
  }
  const plain = roleLabel(kind, p, { unionType });
  card.role = plain;
  const full = roleLabel(kind, p, { half, unionType });
  card.label = `${p.name}, ${relBadge ? `${relBadge} ${full}` : full}, ${years}`;
  return card;
}

function unionEntry(graph, u) {
  const partner = u.partner ? graph.person(u.partner) : null;
  const unionType = u.union.type || null;
  return {
    id: u.union.id,
    tab: partner ? `with ${partner.name}` : COPY.partnerMissing,
    type: unionType,
    partner: u.partner ? personCard(graph, u.partner, "partner", { unionType }) : null,
    children: u.children.map((c) => personCard(graph, c.id, "child", { rel: c.rel }))
  };
}

/** Brothers and sisters: everyone who shares a recorded parent, plus the other children of a union that records no parent at all. */
function siblingsOf(graph, id) {
  const out = new Map(graph.siblings(id).map((s) => [s.id, s]));
  for (const u of graph.data.unions) {
    if (!u || !Array.isArray(u.children) || !u.children.some((c) => c && c.id === id)) continue;
    if ((Array.isArray(u.partners) ? u.partners : []).some((pid) => graph.has(pid))) continue;
    for (const c of u.children) if (c && c.id !== id && graph.has(c.id) && !out.has(c.id)) out.set(c.id, { id: c.id, half: false });
  }
  return [...out.values()];
}

/**
 * What <family-navigator> draws for `focus`:
 *   {id, name, connected, notice, focus: card, parents: {cards, placeholder, message}, unions: [{id, tab, type, partner, children}], siblings: [card]}
 * `connected` is false for a person with no generation, and for a singleton (no parent, partner, child or sibling recorded), which the builder
 * emits as its own component at generation 0: it gets the "not yet connected to the tree" notice and no relative-generation label.
 */
export function navigatorModel(graph, focus) {
  const p = graph.person(focus);
  if (!p) return null;
  const parents = graph.parents(focus);
  const unions = graph.unionsOf(focus).map((u) => unionEntry(graph, u));
  const siblings = siblingsOf(graph, focus);
  const hasRelatives = parents.length > 0 || siblings.length > 0 || unions.some((u) => u.partner || u.children.length > 0);
  const connected = Number.isInteger(p.generation) && hasRelatives;
  return {
    id: focus,
    name: p.name,
    connected,
    notice: connected ? null : COPY.notConnected,
    focus: personCard(graph, focus, "focus", { withPlace: true }),
    parents: {
      cards: parents.map((x) => personCard(graph, x.id, "parent", { rel: x.rel })),
      // One recorded parent leaves the other slot as a dashed placeholder; none recorded is a plain line instead.
      placeholder: parents.length === 1 ? COPY.parentMissing : null,
      message: parents.length === 0 ? COPY.parentsNone : null
    },
    unions,
    siblings: siblings.map((s) => personCard(graph, s.id, "sibling", { half: s.half }))
  };
}

/**
 * What the details sheet lists: {id, name, years, born, died, parents: [{id, name, label}], unions: [{id, title, children: [{id, name, label}]}],
 * childCount, href}. Places are left out for a living person. Names are plain strings: the island renders them with PersonName.
 */
export function detailsModel(graph, id) {
  const p = graph.person(id);
  if (!p) return null;
  const entry = (pid, kind, extra) => {
    const x = graph.person(pid);
    const rel = extra?.rel ?? null;
    const base = roleLabel(kind, x, { half: extra?.half, unionType: extra?.unionType });
    return { id: pid, name: x.name, label: REL_BADGE[rel] && (kind === "parent" || kind === "child") ? `${REL_BADGE[rel]} ${base}` : base };
  };
  const unions = graph.unionsOf(id).map((u) => ({
    id: u.union.id,
    title: u.partner ? `with ${graph.person(u.partner).name}` : COPY.partnerMissing,
    partner: u.partner ? entry(u.partner, "partner", { unionType: u.union.type }) : null,
    children: u.children.map((c) => entry(c.id, "child", { rel: c.rel }))
  }));
  return {
    id,
    name: p.name,
    years: yearsLabel(p),
    born: p.living ? null : placeChain(graph, p.birthPlace),
    died: p.living ? null : placeChain(graph, p.deathPlace),
    parents: graph.parents(id).map((x) => entry(x.id, "parent", { rel: x.rel })),
    unions,
    childCount: graph.children(id).length,
    href: `/person/?id=${encodeURIComponent(id)}`
  };
}
