// The hourglass tree's data adapter and words (HFY-TSK-379, flag familyVizHourglass; design: viz-hourglass-addendum.md, DIGEST sections 4 and 7).
// PURE: no DOM, no fetch, no React. It turns the published person/graph.json (schemaVersion 1, minor 3: people, unions with a per-parent
// rel, faces) into the model of one focus person that both trees draw: the small tree on the person page and the big tree. A plain-DOM
// renderer reads this model and hourglass-layout.js; neither re-derives a relationship.
//
//   indexGraph(data)             the graph.json body (or a FamilyGraph) indexed once; every call below takes the index
//   familyModel(index, id)       the model of one focus person, or null when the id is not in the graph (see below)
//   relWord, partnerWord, stepWord, sibText, ariaName, firstName, shortName, yearsText, COPY, CAP_*   the words and small helpers
//
// Rules the model applies (REPORT.md sections 2 and 3, DIGEST section 7):
//  - Parent union (G7): a person can be a child in several unions. The union whose rel marks a birth link wins, else the first in the file.
//    Only unions with at least one recorded partner count. Father slot is the male partner, mother slot the female one; two partners of the
//    same or an unrecorded sex keep the file order; a one-parent union leaves the other slot empty.
//  - Sex: "m" and "f" have their own words, anything else gets the neutral word (parent, sibling, child, spouse).
//  - Brothers and sisters: the others in the parent union are full; the children of either parent's other unions are half, flagged with the
//    side (0 father's, 1 mother's), the shared parent and the union, so the renderer can draw them dashed. A parent's other union with the same
//    two recorded parents is full.
//  - Words (G6): adopted, step and foster links read the same as a birth link. Only a married union gets spouse words; unmarried,
//    civil_union, unknown and custom read "partner".
//  - Order (G1, G4): partners keep the file order of their unions (the graph has no union year); children and brothers and sisters sort by birth
//    year, stable, with no year last. Every row is de-duplicated by id. The two ancestor rows are structural: a person who stands under both
//    sides is drawn under each, and tagged `both`.
//  - Years: "1880–1942", "b. 1950", "d. 1942", "" for none, "c. " before a year the graph marks approximate; never a word for a missing year.
import { faceUrl, initials } from "./navigator-model.js";

/** Children shown before "+N more children", and grandchildren shown before "+N" (five plus the chip when there are more than six). */
export const CAP_CHILDREN = 4;
export const CAP_GRANDCHILDREN = 6;

/** Every string the model builds or hands to a renderer (T-Copy, DIGEST section 4): lower case, names keep their capitals. */
export const COPY = {
  sides: ["father's side", "mother's side"],
  notKnown: "not known yet.",
  parentsNotKnown: "parents not known yet.",
  parentNotKnown: ["father not known yet.", "mother not known yet."],
  grandparentsNotKnown: { m: "his parents not known yet.", f: "her parents not known yet.", u: "their parents not known yet." },
  tellUs: "know who? tell us",
  thanks: "thank you. tell us in the comments on this page, or text J.",
  fewer: "show fewer",
  also: "also with",
  bothSides: "both sides",
  bothAria: "on both sides of the family",
  seeBig: "see them in the big tree",
  openBig: "open the big tree",
  prefer: "prefer a list?",
  outline: "outline",
  table: "table",
  hideSiblings: "hide brothers and sisters",
  rows: { "-3": "great-grandparents", "-2": "grandparents", "-1": "parents", 1: "children", 2: "grandchildren" },
  moreChildren: (n) => `+${n} more children`,
  moreChip: (n) => `+${n} more`,
  showSiblings: (text) => `${text}. show them`,
  openBigAria: (name) => `open the big tree, centred on ${name}`,
  thisPerson: (name) => `${name}, this person. open the big tree`,
  inMiddle: (name) => `${name}, in the middle now`,
  moreOfChildren: (n, first) => `${n} more of ${first}'s children. put ${first} in the middle`,
  moreGrandchildren: (n) => `${n} more grandchildren. open the big tree`
};

const WORDS = {
  parent: ["father", "mother", "parent"],
  gp: ["grandfather", "grandmother", "grandparent"],
  ggp: ["great-grandfather", "great-grandmother", "great-grandparent"],
  sib: ["brother", "sister", "sibling"],
  half: ["half brother", "half sister", "half sibling"],
  child: ["son", "daughter", "child"],
  gk: ["grandson", "granddaughter", "grandchild"],
  wed: ["husband", "wife", "spouse"],
  step: ["stepfather", "stepmother", "step-parent"]
};

/** The relationship word for a kind (parent, gp, ggp, sib, half, child, gk, wed, step) and a sex ("m", "f", else neutral). */
export function relWord(kind, sex) {
  const t = WORDS[kind];
  return sex === "m" ? t[0] : sex === "f" ? t[1] : t[2];
}

/** "husband" / "wife" / "spouse" for a married union, "partner" for every other type. `sex` is the partner's. */
export const partnerWord = (unionType, sex) => (unionType === "married" ? relWord("wed", sex) : "partner");

/** What a parent's other partner is to the focus person: "stepmother" for a married union, else "father's partner" / "mother's partner". */
export const stepWord = (unionType, parentSex, sex) => (unionType === "married" ? relWord("step", sex) : `${parentSex === "f" ? "mother's" : parentSex === "m" ? "father's" : "parent's"} partner`);

/** "4 brothers and sisters", "1 sister", "3 brothers", "" for none. `list` holds {sex}. */
export function sibText(list) {
  const n = list.length;
  if (!n) return "";
  if (n === 1) return `1 ${relWord("sib", list[0].sex)}`;
  if (list.every((s) => s.sex === "m")) return `${n} brothers`;
  if (list.every((s) => s.sex === "f")) return `${n} sisters`;
  return `${n} brothers and sisters`;
}

/** The accessible name: the name, then each non-empty part after a comma ("Ada Example, mother"). */
export const ariaName = (name, ...parts) => [name, ...parts.filter(Boolean)].join(", ");

const TITLE = /^(?:rev|dr|mr|mrs|ms|miss)\.?\s+/i;
const tokens = (s) => String(s || "").trim().replace(TITLE, "").split(/\s+/).filter(Boolean);

/** The first given name ("Rosalind" for "Rosalind Marguerite"), else the first word of the name. */
export const firstName = (p) => tokens(p.given)[0] || tokens(p.name)[0] || "";

/** "Rosalind Quillon-Ashby": the first given name and the surname; the name's first and last words when either is missing. */
export function shortName(p) {
  const f = tokens(p.given)[0];
  const s = String(p.surname || "").trim();
  if (f && s) return `${f} ${s}`;
  const w = tokens(p.name);
  return w.length > 2 ? `${w[0]} ${w[w.length - 1]}` : w.join(" ");
}

/** The years line: "1880–1942", "b. 1950", "d. 1942", or "" with no year. A "c. " goes before an approximate year; no word for a missing one. */
export function yearsText(p) {
  const year = (v) => (Number.isInteger(v) ? v : null);
  const b = year(p.birthYear);
  const d = year(p.deathYear);
  const c = p.yearApprox ? "c. " : "";
  if (b !== null && d !== null) return `${c}${b}–${d}`;
  if (b !== null) return `b. ${c}${b}`;
  return d !== null ? `d. ${c}${d}` : "";
}

const push = (map, key, v) => (map.has(key) ? map.get(key).push(v) : map.set(key, [v]));

function slotsOf(ids, people) {
  const [a, b] = ids;
  if (!a) return [null, null];
  const sa = people.get(a).sex;
  if (!b) return sa === "f" ? [null, a] : [a, null];
  const sb = people.get(b).sex;
  return (sa === "f" && sb !== "f") || (sb === "m" && sa !== "m") ? [b, a] : [a, b];
}

/**
 * Index a graph.json body (or a FamilyGraph, whose `.data` it uses) once. Ids the graph does not hold are dropped from every union.
 * Returns {people: Map id -> person, unions: Map id -> {id, type, partners, slots, kids, rel}, asPartner: Map, asChild: Map}.
 */
export function indexGraph(source) {
  const data = (source && source.data) || source || {};
  const people = new Map();
  for (const p of data.people || []) people.set(p.id, p);
  const unions = new Map();
  const asPartner = new Map();
  const asChild = new Map();
  for (const u of data.unions || []) {
    const partners = [...new Set(u.partners || [])].filter((x) => people.has(x));
    const kids = (u.children || []).filter((c) => people.has(c.id));
    const info = { id: u.id, type: u.type || "unknown", partners, slots: slotsOf(partners, people), kids: kids.map((c) => c.id), rel: new Map(kids.map((c) => [c.id, c.rel || {}])) };
    unions.set(u.id, info);
    for (const pid of partners) push(asPartner, pid, info);
    for (const c of kids) push(asChild, c.id, info);
  }
  return { people, unions, asPartner, asChild };
}

/** The union a person is a child of, for the tree: the one with a birth link, else the first; null with none that has a recorded parent. */
export function parentUnion(idx, id) {
  const list = (idx.asChild.get(id) || []).filter((u) => u.partners.length);
  return list.find((u) => Object.values(u.rel.get(id)).includes("birth")) || list[0] || null;
}

const yearOf = (idx, id) => (Number.isInteger(idx.people.get(id).birthYear) ? idx.people.get(id).birthYear : Infinity);
const byBirth = (idx, ids) => [...ids].sort((a, b) => yearOf(idx, a) - yearOf(idx, b));

/** [{id, unions}] the person's partners once each, in the file order of their unions; `type` is "married" when any union with them is. */
function partnersOf(idx, id) {
  const out = [];
  for (const u of idx.asPartner.get(id) || []) {
    const other = u.partners.find((x) => x !== id);
    if (!other) continue;
    const hit = out.find((o) => o.id === other);
    if (hit) hit.unions.push(u); else out.push({ id: other, unions: [u] });
  }
  return out.map((o) => ({ ...o, type: o.unions.some((u) => u.type === "married") ? "married" : o.unions[0].type }));
}

/** The person's children across their unions: [{id, union, other}] each once, union by union (birth order inside a union). */
function kidsOf(idx, id, seen = new Set()) {
  const out = [];
  for (const u of idx.asPartner.get(id) || []) {
    for (const k of byBirth(idx, u.kids)) if (!seen.has(k)) { seen.add(k); out.push({ id: k, union: u, other: u.partners.find((x) => x !== id) || null }); }
  }
  return out;
}

/**
 * One person card: {id, role, name, short, first, initials, face (url or null), sex, years, word, aria, both?, side?}. `extra` may carry `side`
 * (a caption added to the accessible name) and `both` (the person stands under both sides; adds the tag word and the spoken phrase).
 */
function card(idx, id, role, word, extra = {}) {
  const p = idx.people.get(id);
  const { side, both, aria, ...rest } = extra;
  return {
    id, role, name: p.name, short: shortName(p), first: firstName(p), initials: initials(p), face: faceUrl(p.face), sex: p.sex === "m" || p.sex === "f" ? p.sex : "u", years: yearsText(p), word,
    aria: aria || ariaName(p.name, word, side, both && COPY.bothAria), both: !!both, ...rest
  };
}

const ghost = (text) => ({ ghost: true, text, tell: true });

function sharedText(idx, couple, kids) {
  const [a, b] = kids.map((k) => idx.people.get(k));
  const pair = a.sex === b.sex && a.sex !== "u" ? (a.sex === "f" ? "sisters" : "brothers") : a.sex === "f" && b.sex === "m" ? "sister and brother" : a.sex === "m" && b.sex === "f" ? "brother and sister" : "siblings";
  const ps = couple.slots.filter(Boolean).map((x) => idx.people.get(x));
  const names = ps.length === 2 && ps[0].surname !== ps[1].surname ? ps.map((p) => `${firstName(p)} ${p.surname || ""}`.trim()).join(" and ") : `${ps.map(firstName).join(" and ")} ${ps[0].surname || ""}`.trim();
  return `${firstName(a)} and ${firstName(b)} were ${pair}, so ${names} ${ps.length === 2 ? "are" : "is"} on both sides of this family.`;
}

/**
 * The model of one focus person, or null when the id is not in the graph.
 *   focus        the person's card (role "focus"; `aria` is the person-page name, `ariaBig` the big tree's)
 *   empty        true with no parents, partners, children or brothers and sisters ("no connections yet")
 *   noParents    true with no recorded parent; then `sides` is null and `parentsGhost` is the one ghost
 *   sides        [father's side, mother's side], each {i, caption (null when that parent is not recorded), parent (card or ghost),
 *                grandparents ([card|ghost, card|ghost] or null), parentsGhost (when the parent has no recorded parents, else null),
 *                others ([card] the parent's other partners with step words, each carrying `unionIds`)}
 *   both         {ids, shared ([{unionId, kids}] couples of grandparents who are brothers or sisters), note ({text, button} or null)}
 *   ggp          [{unionId, shared, slots:[card|null, card|null]}] the great-grandparents, one entry per union of a grandparent's parents
 *                (a grandparent card carries `up`, the id of that union)
 *   siblings     {list ([card + half, halfSide (0 father's, 1 mother's), via, unionId]), text (the toggle label), count}
 *   partners     [card + unionIds, type] in the file order of their unions; the first two flank the person, the rest are "also with" chips
 *   blocks       [{unionId, partner (index in `partners`, -1 for none), kids:[{card, grandchildren:[card + parent]}]}] one per union with children
 *   children     {list, cap, hidden, moreText}  every child, once each; `hidden` counts those past the cap
 *   grandchildren{list, shown, more, namesText, moreAria}  every grandchild; `shown` of them are drawn (cap 6: five and a chip over six)
 */
export function familyModel(idx, id) {
  const f = idx.people.get(id);
  if (!f) return null;
  const pu = parentUnion(idx, id);
  const raw = [0, 1].map((i) => {
    const pid = pu ? pu.slots[i] : null;
    const gu = pid ? parentUnion(idx, pid) : null;
    return { i, pid, gu };
  });
  // Both sides: grandparents who are brothers or sisters (they share a parent union), and a grandparent who stands under both sides.
  const byUnion = new Map();
  for (const s of raw) for (const g of s.gu ? s.gu.slots : []) { const up = g && parentUnion(idx, g); if (up) push(byUnion, up.id, g); }
  const shared = [...byUnion].filter(([, kids]) => new Set(kids).size > 1).map(([unionId, kids]) => ({ unionId, kids: [...new Set(kids)] }));
  const sideIds = raw.map((s) => (s.gu ? s.gu.slots.filter(Boolean) : []));
  const bothIds = new Set([...shared.flatMap((s) => s.kids), ...sideIds[0].filter((g) => sideIds[1].includes(g))]);
  const gpCard = (g, i) => { const up = parentUnion(idx, g); return card(idx, g, "grandparent", relWord("gp", idx.people.get(g).sex), { side: COPY.sides[i], both: bothIds.has(g), up: up ? up.id : null }); };
  const sides = raw.map(({ i, pid, gu }) => {
    const parent = pid ? card(idx, pid, "parent", relWord("parent", idx.people.get(pid).sex)) : ghost(COPY.parentNotKnown[i]);
    const others = [];
    for (const o of pid ? partnersOf(idx, pid) : []) {
      if (pu.partners.includes(o.id)) continue;
      const unions = o.unions.filter((u) => u !== pu);
      others.push(card(idx, o.id, "spouse", stepWord(o.type, idx.people.get(pid).sex, idx.people.get(o.id).sex), { unionIds: unions.map((u) => u.id) }));
    }
    return {
      i, caption: pid ? COPY.sides[i] : null, parent,
      grandparents: gu ? gu.slots.map((g) => (g ? gpCard(g, i) : ghost(COPY.notKnown))) : null,
      parentsGhost: pid && !gu ? ghost(COPY.grandparentsNotKnown[idx.people.get(pid).sex] || COPY.grandparentsNotKnown.u) : null,
      others
    };
  });
  const ggp = [];
  for (const [unionId, kids] of byUnion) {
    const u = idx.unions.get(unionId);
    const isShared = kids.length > 1;
    ggp.push({ unionId, shared: isShared, slots: u.slots.map((g) => (g ? card(idx, g, "grandparent", relWord("ggp", idx.people.get(g).sex), { both: isShared }) : null)) });
  }
  // The person's row.
  const partners = partnersOf(idx, id).map((o) => card(idx, o.id, "spouse", partnerWord(o.type, idx.people.get(o.id).sex), { unionIds: o.unions.map((u) => u.id), type: o.type }));
  const sibs = [];
  if (pu) {
    const seen = new Set([id]);
    const own = pu.partners.slice().sort().join();
    const add = (k, half, i, via, union) => {
      if (seen.has(k)) return;
      seen.add(k);
      const sex = idx.people.get(k).sex;
      const word = half ? `${relWord("half", sex)}, ${COPY.sides[i]}` : relWord("sib", sex);
      sibs.push(card(idx, k, "sibling", word, { half, halfSide: half ? i : null, via: half ? via : null, unionId: union.id }));
    };
    for (const k of pu.kids) add(k, false, null, null, pu);
    pu.slots.forEach((pid, i) => {
      for (const u of pid ? idx.asPartner.get(pid) : []) if (u !== pu) for (const k of u.kids) add(k, u.partners.slice().sort().join() !== own, i, pid, u);
    });
  }
  const siblings = byBirthCards(idx, sibs);
  // Children and grandchildren, union by union.
  const seenKid = new Set([id]);
  const seenGk = new Set([id]);
  const withKids = (idx.asPartner.get(id) || []).filter((u) => u.kids.length);
  const blocks = [];
  for (const u of withKids) {
    const other = u.partners.find((x) => x !== id) || null;
    const kids = [];
    for (const k of byBirth(idx, u.kids)) {
      if (seenKid.has(k)) continue;
      seenKid.add(k);
      const sex = idx.people.get(k).sex;
      const word = relWord("child", sex) + (withKids.length > 1 && other ? ` with ${firstName(idx.people.get(other))}` : "");
      const parentFirst = firstName(idx.people.get(k));
      const grandchildren = kidsOf(idx, k, seenGk).map((g) => {
        const gsex = idx.people.get(g.id).sex;
        return card(idx, g.id, "grandchild", relWord("gk", gsex), { parent: k, aria: ariaName(idx.people.get(g.id).name, relWord("gk", gsex), `${parentFirst}'s ${relWord("child", gsex)}`) });
      });
      kids.push({ card: card(idx, k, "child", word), grandchildren });
    }
    blocks.push({ unionId: u.id, partner: other ? partners.findIndex((p) => p.id === other) : -1, kids });
  }
  const childList = blocks.flatMap((b, bi) => b.kids.map((k) => ({ ...k.card, block: bi })));
  const gkList = blocks.flatMap((b) => b.kids.flatMap((k) => k.grandchildren));
  const gkShown = gkList.length > CAP_GRANDCHILDREN ? CAP_GRANDCHILDREN - 1 : gkList.length;
  const gkMore = gkList.length - gkShown;
  const gkNames = gkList.slice(0, gkShown).map((g) => g.first);
  const namesText = !gkList.length ? "" : `grandchildren: ${gkMore ? `${gkNames.join(", ")} and ${gkMore} more` : gkNames.length > 1 ? `${gkNames.slice(0, -1).join(", ")} and ${gkNames[gkNames.length - 1]}` : gkNames[0]}`;
  const note = shared.length ? { text: sharedText(idx, idx.unions.get(shared[0].unionId), shared[0].kids), button: COPY.seeBig } : null;
  return {
    id,
    focus: card(idx, id, "focus", "", { aria: COPY.thisPerson(f.name), ariaBig: COPY.inMiddle(f.name) }),
    empty: !pu && !partners.length && !childList.length && !siblings.length,
    noParents: !pu,
    parentsGhost: pu ? null : ghost(COPY.parentsNotKnown),
    sides: pu ? sides : null,
    both: { ids: [...bothIds], shared, note },
    ggp,
    siblings: { list: siblings, text: sibText(siblings), count: siblings.length },
    partners,
    blocks,
    children: { list: childList, cap: CAP_CHILDREN, hidden: Math.max(0, childList.length - CAP_CHILDREN), moreText: childList.length > CAP_CHILDREN ? COPY.moreChildren(childList.length - CAP_CHILDREN) : "" },
    grandchildren: { list: gkList, shown: gkShown, more: gkMore, namesText, moreAria: gkMore ? COPY.moreGrandchildren(gkMore) : "" }
  };
}

function byBirthCards(idx, cards) {
  const year = (c) => yearOf(idx, c.id);
  return cards.slice().sort((a, b) => year(a) - year(b));
}
