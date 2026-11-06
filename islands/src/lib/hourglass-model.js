// The hourglass tree's data adapter and words (HFY-TSK-379, flag familyVizHourglass; design: viz-hourglass-addendum.md, DIGEST sections 4 and 7).
// PURE: no DOM, no fetch, no React. It turns the published person/graph.json (schemaVersion 1, minor 3: people, unions with a per-parent
// rel, faces) into the model of one focus person that both trees draw: the small tree on the person page and the big tree. A plain-DOM
// renderer reads this model and hourglass-layout.js; neither re-derives a relationship. What only the big tree needs (the parents' other
// partners and the great-grandparents) is added by bigModel() in hourglass-big.js, so the person page's chunk never carries it.
//
//   indexGraph(data)             the graph.json body (or a FamilyGraph) indexed once; every call below takes the index
//   familyModel(index, id)       the model of one focus person, or null when the id is not in the graph (see below)
//   relWord, partnerWord, sibText, ariaName, firstName, shortName, yearsText, COPY, CAP_*   the words and small helpers
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
//  - Both sides: grandparents who are brothers or sisters (they share a parent union) give the note and the `both` tags; a grandparent who
//    stands under both parents is tagged too, with no note (nobody to name).
//  - Years: "1880–1942", "b. 1950", "d. 1942", "" for none, "c. " before a year the graph marks approximate; never a word for a missing year.

/** Children shown before "+N more children", and grandchildren shown before "+N" (five plus the chip when there are more than six). */
export const CAP_CHILDREN = 4;
export const CAP_GRANDCHILDREN = 6;

/** Every string the small tree and the model build (T-Copy, DIGEST section 4): lower case, names keep their capitals. The big tree's are in hourglass-big.js. */
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
  moreChildren: (n) => `+${n} more children`,
  moreChip: (n) => `+${n} more`,
  showSiblings: (text) => `${text}. show them`,
  openBigAria: (name) => `open the big tree, centred on ${name}`,
  thisPerson: (name) => `${name}, this person. open the big tree`,
  moreGrandchildren: (n) => `${n} more grandchildren. open the big tree`
};

// kind -> "male|female|neutral"
const WORDS = {
  parent: "father|mother|parent", gp: "grandfather|grandmother|grandparent", ggp: "great-grandfather|great-grandmother|great-grandparent",
  sib: "brother|sister|sibling", half: "half brother|half sister|half sibling", child: "son|daughter|child", gk: "grandson|granddaughter|grandchild",
  wed: "husband|wife|spouse", step: "stepfather|stepmother|step-parent"
};

/** The relationship word for a kind (parent, gp, ggp, sib, half, child, gk, wed, step) and a sex ("m", "f", else neutral). */
export const relWord = (kind, sex) => WORDS[kind].split("|").at([..."mf"].indexOf(sex)); // -1 reads the last: the neutral word

/** "husband" / "wife" / "spouse" for a married union, "partner" for every other type. `sex` is the partner's. */
export const partnerWord = (unionType, sex) => (unionType === "married" ? relWord("wed", sex) : "partner");

/** "4 brothers and sisters", "1 sister", "3 brothers", "" for none. `list` holds {sex}. */
export const sibText = (list) => {
  const n = list.length;
  const all = (s) => list.every((x) => x.sex === s);
  return !n ? "" : n === 1 ? `1 ${relWord("sib", list[0].sex)}` : `${n} ${all("m") ? "brothers" : all("f") ? "sisters" : "brothers and sisters"}`;
};

/** The accessible name: the name, then each non-empty part after a comma ("Ada Example, mother"). */
export const ariaName = (name, ...parts) => [name, ...parts.filter(Boolean)].join(", ");

const tokens = (s) => String(s || "").trim().replace(/^(?:rev|dr|mr|mrs|ms|miss)\.?\s+/i, "").split(/\s+/).filter(Boolean);

/** The first given name ("Rosalind" for "Rosalind Marguerite"), else the first word of the name. */
export const firstName = (p) => tokens(p.given)[0] || tokens(p.name)[0] || "";

/** "Rosalind Quillon-Ashby": the first given name and the surname; the name's first and last words when either is missing. */
export function shortName(p) {
  const f = tokens(p.given)[0];
  const s = String(p.surname || "").trim();
  const w = tokens(p.name);
  return f && s ? `${f} ${s}` : w.length > 2 ? `${w[0]} ${w[w.length - 1]}` : w.join(" ");
}

/** The years line: "1880–1942", "b. 1950", "d. 1942", or "" with no year. A "c. " goes before an approximate year; no word for a missing one. */
export function yearsText(p) {
  const [b, d] = [p.birthYear, p.deathYear].map((v) => (Number.isInteger(v) ? v : null));
  const c = p.yearApprox ? "c. " : "";
  return b !== null && d !== null ? `${c}${b}–${d}` : b !== null ? `b. ${c}${b}` : d !== null ? `d. ${c}${d}` : "";
}

const push = (map, key, v) => (map.has(key) ? map.get(key).push(v) : map.set(key, [v]));
const uniq = (list) => [...new Set(list)];

/** The graph's own face crops only (faces/<id>-<hash>.webp); anything else is initials. Up to two letters for the initials avatar. */
const faceOf = (f) => (/^faces\/[A-Za-z0-9_-]+\.webp$/.test(f) ? `/media/${f}` : null);
const initialsOf = (p) => {
  const w = tokens(p.name);
  const l = p.given && p.surname ? [String(p.given).trim(), String(p.surname).trim()] : w.length > 1 ? [w[0], w[w.length - 1]] : w;
  return l.map((x) => [...x][0]).join("").toUpperCase() || "?";
};

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
  const people = new Map((data.people || []).map((p) => [p.id, p]));
  const unions = new Map();
  const asPartner = new Map();
  const asChild = new Map();
  for (const u of data.unions || []) {
    const partners = uniq(u.partners || []).filter((x) => people.has(x));
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

const person = (idx, id) => idx.people.get(id);
const yearOf = (idx, id) => (Number.isInteger(person(idx, id).birthYear) ? person(idx, id).birthYear : Infinity);
const byBirth = (idx, ids, key = (x) => x) => [...ids].sort((a, b) => yearOf(idx, key(a)) - yearOf(idx, key(b)));
const other = (u, id) => u.partners.find((x) => x !== id) || null;

/** [{id, unions, type}] the person's partners once each, in the file order of their unions; `type` is "married" when any union with them is. */
export function partnersOf(idx, id) {
  const out = [];
  for (const u of idx.asPartner.get(id) || []) {
    const o = other(u, id);
    if (!o) continue;
    const hit = out.find((x) => x.id === o);
    if (hit) hit.unions.push(u); else out.push({ id: o, unions: [u] });
  }
  return out.map((o) => ({ ...o, type: o.unions.some((u) => u.type === "married") ? "married" : o.unions[0].type }));
}

/**
 * One person card: {id, role, name, short, first, initials, face (url or null), sex, years, word, aria, both}. `extra` may carry `side`
 * (a caption added to the accessible name), `both` (the person stands under both sides; adds the tag word and the spoken phrase) and `aria`.
 */
export function card(idx, id, role, word, extra = {}) {
  const p = person(idx, id);
  const { side, both, aria, ...rest } = extra;
  return {
    id, role, name: p.name, short: shortName(p), first: firstName(p), initials: initialsOf(p), face: faceOf(p.face), sex: "mf".includes(p.sex || "u") ? p.sex : "u", years: yearsText(p), word,
    aria: aria || ariaName(p.name, word, side, both && COPY.bothAria), both: !!both, ...rest
  };
}

const ghost = (text) => ({ ghost: true, text, tell: true });

/**
 * The "both sides" note for the first union of grandparents who are brothers and sisters, naming every one of them ("Ann and Bo were sisters, so
 * Cy Sample and Di Sample are on both sides of this family"; three or more read "Ann, Bo and Cy were siblings"). Any further shared union is
 * shown by the tags and the gold lines, not by a second sentence.
 */
function sharedText(idx, couple, kids) {
  const ks = kids.map((k) => person(idx, k));
  const t = ks.map((k) => k.sex).join("");
  const pair = /^f+$/.test(t) ? "sisters" : /^m+$/.test(t) ? "brothers" : { fm: "sister and brother", mf: "brother and sister" }[t] || "siblings";
  const who = ks.map(firstName);
  const list = who.length > 1 ? `${who.slice(0, -1).join(", ")} and ${who.pop()}` : who[0] || "";
  const ps = couple.slots.filter(Boolean).map((x) => person(idx, x));
  const sur = (ps[0] || {}).surname || "";
  const names = ps.length === 2 && sur !== ps[1].surname ? ps.map((p) => `${firstName(p)} ${p.surname || ""}`.trim()).join(" and ") : `${ps.map(firstName).join(" and ")} ${sur}`.trim();
  return `${list} were ${pair}, so ${ps.length ? `${names} ${ps.length === 2 ? "are" : "is"}` : "their parents are"} on both sides of this family.`;
}

/**
 * The model of one focus person, or null when the id is not in the graph.
 *   focus        the person's card (role "focus"; `aria` is the person-page name)
 *   empty        true with no parents, partners, children or brothers and sisters ("no connections yet")
 *   noParents    true with no recorded parent; then `sides` is null and `parentsGhost` is the one ghost
 *   sides        [father's side, mother's side], each {i, caption (null when that parent is not recorded), parent (card or ghost),
 *                grandparents ([card|ghost, card|ghost] or null), parentsGhost (when the parent has no recorded parents, else null)}
 *   both         {ids, shared ([{unionId, kids}] couples of grandparents who are brothers or sisters), note ({text, button} or null)}
 *   siblings     {list ([card + half, halfSide (0 father's, 1 mother's), via, unionId]), text (the toggle label), count}
 *   partners     [card + type] in the file order of their unions; the first two flank the person, the rest are "also with" chips
 *   blocks       [{unionId, partner (index in `partners`, -1 for none), kids:[{card, grandchildren:[card + parent]}]}] one per union with children
 *   children     {list, cap, moreText}  every child, once each; `moreText` is "+N more children" past the cap
 *   grandchildren{list, shown, more, namesText, moreAria}  every grandchild; `shown` of them are drawn (cap 6: five and a chip over six)
 */
export function familyModel(idx, id) {
  const f = person(idx, id);
  if (!f) return null;
  const sexOf = (x) => person(idx, x).sex;
  const pu = parentUnion(idx, id);
  const raw = [0, 1].map((i) => {
    const pid = pu ? pu.slots[i] : null;
    return { i, pid, gu: pid ? parentUnion(idx, pid) : null };
  });
  // Both sides: grandparents who are brothers or sisters (they share a parent union), and a grandparent who stands under both sides.
  const byUnion = new Map();
  for (const s of raw) for (const g of s.gu ? s.gu.slots : []) { const up = g && parentUnion(idx, g); if (up) push(byUnion, up.id, g); }
  const shared = [...byUnion].filter(([, kids]) => uniq(kids).length > 1).map(([unionId, kids]) => ({ unionId, kids: uniq(kids) }));
  const sideIds = raw.map((s) => (s.gu ? s.gu.slots.filter(Boolean) : []));
  const bothIds = new Set([...shared.flatMap((s) => s.kids), ...sideIds[0].filter((g) => sideIds[1].includes(g))]);
  const sides = raw.map(({ i, pid, gu }) => ({
    i, caption: pid ? COPY.sides[i] : null,
    parent: pid ? card(idx, pid, "parent", relWord("parent", sexOf(pid))) : ghost(COPY.parentNotKnown[i]),
    grandparents: gu ? gu.slots.map((g) => (g ? card(idx, g, "grandparent", relWord("gp", sexOf(g)), { side: COPY.sides[i], both: bothIds.has(g) }) : ghost(COPY.notKnown))) : null,
    parentsGhost: pid && !gu ? ghost(COPY.grandparentsNotKnown[sexOf(pid)] || COPY.grandparentsNotKnown.u) : null
  }));
  // The person's row.
  const partners = partnersOf(idx, id).map((o) => card(idx, o.id, "spouse", partnerWord(o.type, sexOf(o.id)), { type: o.type }));
  const sibs = [];
  if (pu) {
    const seen = new Set([id]);
    const own = pu.partners.slice().sort().join();
    const add = (k, half, i, via, u) => {
      if (seen.has(k)) return;
      seen.add(k);
      const sex = sexOf(k);
      sibs.push(card(idx, k, "sibling", half ? `${relWord("half", sex)}, ${COPY.sides[i]}` : relWord("sib", sex), { half, halfSide: half ? i : null, via: half ? via : null, unionId: u.id }));
    };
    for (const k of pu.kids) add(k, false, null, null, pu);
    pu.slots.forEach((pid, i) => {
      for (const u of pid ? idx.asPartner.get(pid) : []) if (u !== pu) for (const k of u.kids) add(k, u.partners.slice().sort().join() !== own, i, pid, u);
    });
  }
  const siblings = byBirth(idx, sibs, (c) => c.id);
  // Children and grandchildren, union by union.
  const seenKid = new Set([id]);
  const seenGk = new Set([id]);
  const withKids = (idx.asPartner.get(id) || []).filter((u) => u.kids.length);
  const blocks = withKids.map((u) => {
    const o = other(u, id);
    const kids = [];
    for (const k of byBirth(idx, u.kids)) {
      if (seenKid.has(k)) continue;
      seenKid.add(k);
      const first = firstName(person(idx, k));
      const grandchildren = [];
      for (const pu2 of idx.asPartner.get(k) || []) {
        for (const g of byBirth(idx, pu2.kids)) {
          if (seenGk.has(g)) continue;
          seenGk.add(g);
          const gs = sexOf(g);
          grandchildren.push(card(idx, g, "grandchild", relWord("gk", gs), { parent: k, aria: ariaName(person(idx, g).name, relWord("gk", gs), `${first}'s ${relWord("child", gs)}`) }));
        }
      }
      kids.push({ card: card(idx, k, "child", relWord("child", sexOf(k)) + (withKids.length > 1 && o ? ` with ${firstName(person(idx, o))}` : "")), grandchildren });
    }
    return { unionId: u.id, partner: o ? partners.findIndex((p) => p.id === o) : -1, kids };
  });
  const childList = blocks.flatMap((b, bi) => b.kids.map((k) => ({ ...k.card, block: bi })));
  const gkList = blocks.flatMap((b) => b.kids.flatMap((k) => k.grandchildren));
  const shown = gkList.length > CAP_GRANDCHILDREN ? CAP_GRANDCHILDREN - 1 : gkList.length;
  const more = gkList.length - shown;
  const gk = gkList.slice(0, shown).map((g) => g.first);
  const namesText = !gkList.length ? "" : `grandchildren: ${more ? `${gk.join(", ")} and ${more} more` : gk.length > 1 ? `${gk.slice(0, -1).join(", ")} and ${gk[gk.length - 1]}` : gk[0]}`;
  return {
    id,
    focus: card(idx, id, "focus", "", { aria: COPY.thisPerson(f.name) }),
    empty: !pu && !partners.length && !childList.length && !siblings.length,
    noParents: !pu,
    parentsGhost: pu ? null : ghost(COPY.parentsNotKnown),
    sides: pu ? sides : null,
    both: { ids: [...bothIds], shared, note: shared.length ? { text: sharedText(idx, idx.unions.get(shared[0].unionId), shared[0].kids), button: COPY.seeBig } : null },
    siblings: { list: siblings, text: sibText(siblings), count: siblings.length },
    partners,
    blocks,
    children: { list: childList, cap: CAP_CHILDREN, moreText: childList.length > CAP_CHILDREN ? COPY.moreChildren(childList.length - CAP_CHILDREN) : "" },
    grandchildren: { list: gkList, shown, more, namesText, moreAria: more ? COPY.moreGrandchildren(more) : "" }
  };
}
