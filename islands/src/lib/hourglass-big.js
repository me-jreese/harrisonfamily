// The hourglass tree's big-tree geometry (HFY-TSK-379, flag familyVizHourglass; DIGEST sections 2, 6 and 7). PURE: numbers and plain records in,
// plain records out; no DOM, no fetch. It lives apart from hourglass-layout.js so the person page's chunk, which draws only the small tree,
// never carries the big tree (the chunk budget is about 25 KB; see the size evidence in the pass report): the big tree's chunk imports this file.
//
//   bigLayout(model, level, {sibsOpen, ggp})   the big tree: nodes, strips, rings, row labels, canvas size, the centre
//   seeAll(model, opts, viewport)              "see all": the faces-only layout and whether it fits the viewport
//   scrollTarget(layout, viewport)             where to scroll so the person sits in the middle of the viewport
//   defaultLevel(viewportWidth), SIZES         the four big-tree card sizes and the one a viewport starts at
//   bigModel(index, id)                        the model of hourglass-model.js plus what only the big tree draws: the parents' other
//                                              partners (`sides[i].others`), the great-grandparents (`ggp`, a grandparent's `up`) and `focus.ariaBig`
import { COPY, card, familyModel, parentUnion, partnersOf, push, relWord } from "./hourglass-model.js";
import { DASH, REP, comb } from "./hourglass-dom.js";

const RING = 10;
const PAD = 24;

/** The big tree's own strings (T-Copy): the row names on the ground and the chips and names that only it has. */
export const BIG_COPY = {
  rows: { "-3": "great-grandparents", "-2": "grandparents", "-1": "parents", 1: "children", 2: "grandchildren" },
  inMiddle: (name) => `${name}, in the middle now`,
  moreOfChildren: (n, first) => `${n} more of ${first}'s children. put ${first} in the middle`
};

/** What a parent's other partner is to the focus person: "stepmother" for a married union, else "father's partner" / "mother's partner". */
export const stepWord = (unionType, parentSex, sex) => (unionType === "married" ? relWord("step", sex) : `${relWord("parent", parentSex)}'s partner`);

/**
 * The model of one focus person for the big tree: familyModel plus `sides[i].others` ([card with `unionIds`] the parent's other partners with step
 * words), `ggp` ([{unionId, shared, slots:[card|null, card|null]}] the great-grandparents, one entry per union of a grandparent's parents; `shared`
 * when two or more grandparents are its children) and, on each grandparent card, `up` (the id of that union).
 */
export function bigModel(idx, id) {
  const m = familyModel(idx, id);
  if (!m) return null;
  const pu = parentUnion(idx, id);
  const byUnion = new Map();
  const sexOf = (x) => idx.people.get(x).sex;
  m.focus.ariaBig = BIG_COPY.inMiddle(m.focus.name);
  for (const s of m.sides || []) {
    s.others = s.parent.ghost ? [] : partnersOf(idx, s.parent.id).filter((o) => !pu.partners.includes(o.id)).map((o) => card(idx, o.id, "spouse", stepWord(o.type, sexOf(s.parent.id), sexOf(o.id)), { unionIds: o.unions.filter((u) => u !== pu).map((u) => u.id) }));
    for (const g of s.grandparents || []) {
      const up = !g.ghost && parentUnion(idx, g.id);
      if (up) { g.up = up.id; push(byUnion, up.id, g.id); }
    }
  }
  m.ggp = [...byUnion].map(([unionId, kids]) => {
    const shared = kids.length > 1; // a grandparent under both sides counts twice
    return { unionId, shared, slots: idx.unions.get(unionId).slots.map((g) => (g ? card(idx, g, "grandparent", relWord("ggp", sexOf(g)), { both: shared }) : null)) };
  });
  return m;
}

/** The four big-tree sizes (T-Spec): faces only, small, medium, large. nw/nh card, gx/gy column and row gap, av photo, all px. */
export const SIZES = [
  { name: "faces only", nw: 48, nh: 48, gx: 6, gy: 60, av: 44 },
  { name: "small", nw: 128, nh: 184, gx: 12, gy: 64, av: 40 },
  { name: "medium", nw: 168, nh: 232, gx: 16, gy: 68, av: 56 },
  { name: "large", nw: 208, nh: 264, gx: 20, gy: 76, av: 72 }
];

/** A size level kept between 0 and 3. */
export const clamp = (n) => Math.max(0, Math.min(3, n));

/** The size a viewport starts at: medium from 700 px, else small. */
export const defaultLevel = (viewportWidth) => (viewportWidth >= 700 ? 2 : 1);

/**
 * The big tree at one of the four sizes (`level` 0 to 3), around the model's focus person. `sibsOpen` opens the brothers and sisters beside the
 * person; `ggp` shows the great-grandparents. Positions are in card units inside, then px: a card's x is x * (width + column gap).
 * Returns {level, size, nodes, strips, rings, labels, width, height, centre, canShowGgp}:
 *   nodes   [{key, kind, g, left, top, width, height, cx, ...}] in reading order (ancestors, the person's row, descendants):
 *             kind "person" {card, role, name (full from medium, short below), text (false at faces only), showBoth, current, aria}
 *             kind "chip"   {role, label, aria, expanded, act ("sibs" or "go"), target}   brothers and sisters, "+N more" grandchildren
 *             kind "ghost"  {text, label ("?" at faces only), tell (offers "know who? tell us")}
 *   strips  [{x, y, w, h, dashed, rep}] under the cards      rings [{cx, cy, size}] on the marriage brackets
 *   labels  [{text, x, y, g}] the row names on the ground    centre {x, y} the person's centre in canvas px
 * The parents' other partners show from medium (level 2). Half-brothers and half-sisters hang dashed from the shared parent's other union.
 */
export function bigLayout(model, level, { sibsOpen = false, ggp = false } = {}) {
  const lv = clamp(Math.trunc(level) || 0);
  const L = SIZES[lv];
  const unit = L.nw + L.gx;
  const items = [];
  const add = (it) => (items.push(it), it);
  const person = (card, g, x) => add({ kind: "person", card, g, x, role: card.role, name: lv >= 2 ? card.name : card.short, text: lv > 0, showBoth: card.both && lv > 0, current: card.id === model.id, aria: card.id === model.id ? card.ariaBig : card.aria });
  const ghostItem = (gh, g, x) => add({ kind: "ghost", g, x, text: gh.text, label: lv ? gh.text : "?", tell: gh.tell && lv > 0 });
  const chip = (g, x, role, label, aria, act, expanded, target) => add({ kind: "chip", g, x, role, label, aria, act, expanded, target });
  person(model.focus, 0, 0);
  model.partners.forEach((c, i) => person(c, 0, i + 1));
  const sibs = model.siblings.list;
  const sibX = new Map();
  const right = (s) => s.half && s.halfSide === 1;
  const sibLeft = sibsOpen ? sibs.filter((s) => !right(s)) : [];
  if (sibs.length) {
    const sibChip = (x, label, aria, open) => chip(0, x, "sibling", label, aria, "sibs", open);
    if (!sibsOpen) sibChip(-1, lv ? model.siblings.text : `+${sibs.length}`, COPY.showSiblings(model.siblings.text), false);
    else {
      const place = (s, x) => (sibX.set(s.id, x), person(s, 0, x));
      sibLeft.forEach((s, i) => place(s, i - sibLeft.length));
      sibs.filter(right).forEach((s, i) => place(s, model.partners.length + 1 + i));
      sibChip(-(sibLeft.length + 1), lv ? "hide" : "-", COPY.hideSiblings, true);
    }
  }
  // Parents, their other partners, grandparents.
  const slots = [];
  if (model.noParents) ghostItem(model.parentsGhost, -1, 0);
  else {
    for (const s of model.sides) {
      const d = s.i ? 1 : -1; // the father's side is on the left
      const sl = { s, x: d / 2, others: [], gp: null, gx: d };
      slots.push(sl);
      if (s.parent.ghost) { ghostItem(s.parent, -1, sl.x); continue; }
      person(s.parent, -1, sl.x);
      if (lv >= 2) s.others.forEach((o, j) => { sl.others.push({ o, x: d * (1.5 + j) }); person(o, -1, d * (1.5 + j)); });
      if (!s.grandparents) { ghostItem(s.parentsGhost, -2, d); continue; }
      sl.gp = s.grandparents.map((gc, j) => {
        const x = d + (j ? 0.5 : -0.5);
        if (gc.ghost) ghostItem(gc, -2, x); else person(gc, -2, x);
        return { x, ghost: !!gc.ghost };
      });
    }
  }
  // Great-grandparents, once per union of a grandparent's parents; groups are pushed apart so they never overlap.
  let gg = [];
  if (ggp) {
    const groups = new Map();
    for (const it of items) if (it.g === -2 && it.card?.up) push(groups, it.card.up, it.x);
    gg = [...groups].map(([unionId, kids]) => {
      const m = model.ggp.find((z) => z.unionId === unionId);
      const cards = m.slots.filter(Boolean);
      return { kids, cards, shared: m.shared, want: kids.reduce((s, x) => s + x, 0) / kids.length, half: cards.length / 2 };
    }).filter((z) => z.cards.length).sort((a, b) => a.want - b.want);
    let edge = -Infinity;
    for (const z of gg) { z.c = Math.max(z.want, edge + z.half); edge = z.c + z.half; }
    const last = gg.at(-1);
    const drift = last ? last.c - last.want : 0;
    for (const z of gg) {
      z.c -= drift / 2;
      z.xs = z.cards.map((c, j) => { const x = z.c + (z.cards.length === 2 ? j - 0.5 : 0); person(c, -3, x); return x; });
    }
  }
  // Children and grandchildren, in blocks per union that never overlap.
  const blocks = [];
  let prevEnd = -1e9;
  model.blocks.filter((b) => b.kids.length).forEach((b, bi) => {
    const px = b.partner >= 0 ? b.partner + 1 : 0;
    const ks = b.kids.map((k) => {
      const shown = k.grandchildren.length > 3 ? k.grandchildren.slice(0, 2) : k.grandchildren;
      const more = k.grandchildren.length - shown.length;
      return { k, shown, more, sw: Math.max(1, shown.length + (more ? 1 : 0)), gxs: [] };
    });
    const total = ks.reduce((s, k) => s + k.sw, 0);
    const s0 = Math.max(px / 2 - total / 2, prevEnd);
    prevEnd = s0 + total;
    let acc = 0;
    for (const k of ks) {
      k.x = s0 + acc + k.sw / 2 - 0.5;
      person(k.k.card, 1, k.x);
      k.shown.forEach((gc, j) => { person(gc, 2, s0 + acc + j); k.gxs.push(s0 + acc + j); });
      if (k.more) {
        const gx = s0 + acc + k.shown.length;
        chip(2, gx, "grandchild", lv ? COPY.moreChip(k.more) : `+${k.more}`, BIG_COPY.moreOfChildren(k.more, k.k.card.first), "go", undefined, k.k.card.id);
        k.gxs.push(gx);
      }
      acc += k.sw;
    }
    blocks.push({ px, ks, bi });
  });
  // Geometry.
  const gsAll = items.map((i) => i.g);
  const gmin = Math.min(...gsAll);
  const gmax = Math.max(...gsAll);
  const top0 = lv === 0 ? 34 : 40;
  const Y = (g) => top0 + (g - gmin) * (L.nh + L.gy);
  const minX = Math.min(...items.map((i) => i.x * unit - L.nw / 2));
  const maxX = Math.max(...items.map((i) => i.x * unit + L.nw / 2));
  const sx = PAD - minX;
  const PX = (x) => x * unit + sx;
  const strips = [];
  const rings = [];
  const bottom = (x, g) => ({ x: PX(x), y: Y(g) + L.nh });
  // The k-th of n brackets or bars sharing one row gap goes 7 (brackets) or 5 (bars) px lower than the one before, but never more than the
  // gap can hold: with many partners or child blocks the offsets are squeezed to fit, so a strip never leaves the two rows it joins.
  const spread = (k, n, per, room) => (n > 1 ? Math.min(k, n - 1) * Math.min(per, Math.max(0, room) / (n - 1)) : 0);
  const bracket = (xa, xb, g, k, n, st) => {
    const y0 = Y(g) + L.nh;
    const yb = y0 + 10 + spread(k, n, 7, 0.6 * L.gy - 10);
    const a = PX(xa);
    const b = PX(xb);
    strips.push(...comb([a, b], [], 0, st, yb - y0, y0));
    rings.push({ cx: (a + b) / 2, cy: yb, size: RING });
    return { x: (a + b) / 2, y: yb };
  };
  const hang = (mid, xs, gChild, k, n, st) => {
    if (!xs.length) return;
    const top = Y(gChild);
    const yBar = Math.min(Math.max(mid.y + 10, top - L.gy / 2 + spread(k, n, 5, L.gy / 2 - 8)), top - 6);
    strips.push(...comb([mid.x], xs.map(PX), top - mid.y, st, yBar - mid.y, mid.y));
  };
  if (model.noParents) strips.push(...comb([PX(0)], [], 0, DASH, Y(0) - Y(-1) - L.nh, Y(-1) + L.nh));
  else {
    // One bracket and one comb per (parent, other partner) pair, however many half brothers and sisters hang from it.
    const fullCount = sibs.filter((s) => !s.half).length;
    const groups = new Map();
    for (const s of sibs) {
      if (!s.half) continue;
      const sl = slots[s.halfSide];
      const ot = sl.others.find((z) => z.o.unionIds.includes(s.unionId));
      const key = `${s.halfSide}:${ot ? ot.o.id : "-"}`;
      (groups.get(key) || groups.set(key, { sl, ot, xs: [] }).get(key)).xs.push(sibsOpen ? sibX.get(s.id) : -1);
    }
    const gv = [...groups.values()];
    // Opened, every group hangs its own half brothers and sisters. Closed, the chip hangs solid when it holds a full one, else dashed from
    // the first group, so the two states draw the same kind of line.
    const hung = sibsOpen ? gv : fullCount || !gv.length ? [] : [{ ...gv[0], xs: [-1] }];
    const n = 1 + hung.length;
    const mid = bracket(-0.5, 0.5, -1, 0, n, slots.some((s) => s.s.parent.ghost) && DASH);
    const full = [0];
    if (sibs.length && !sibsOpen && fullCount) full.push(-1);
    for (const s of sibLeft) if (!s.half) full.push(sibX.get(s.id));
    hang(mid, full, 0, 0, n);
    hung.forEach(({ sl, ot, xs }, i) => hang(ot ? bracket(sl.x, ot.x, -1, i + 1, n, DASH) : bottom(sl.x, -1), xs, 0, i + 1, n, DASH));
    for (const sl of slots) {
      if (sl.s.parent.ghost) continue;
      if (sl.gp) { const st = sl.gp.some((z) => z.ghost) && DASH; hang(bracket(sl.gp[0].x, sl.gp[1].x, -2, 0, 1, st), [sl.x], -1, 0, 1, st); }
      else hang(bottom(sl.gx, -2), [sl.x], -1, 0, 1, DASH);
    }
    for (const z of gg) { const st = z.shared && REP; hang(z.xs.length === 2 ? bracket(z.xs[0], z.xs[1], -3, 0, 1, st) : bottom(z.xs[0], -3), z.kids, -2, 0, 1, st); }
  }
  const mids = model.partners.map((_, i) => bracket(0, i + 1, 0, i, model.partners.length));
  for (const bk of blocks) {
    hang(bk.px ? mids[bk.px - 1] : bottom(0, 0), bk.ks.map((k) => k.x), 1, bk.bi, blocks.length);
    for (const k of bk.ks) if (k.gxs.length) hang(bottom(k.x, 1), k.gxs, 2, 0, 1);
  }
  // Nodes, in reading order.
  const nodes = items.sort((a, b) => a.g - b.g || a.x - b.x).map((it) => Object.assign(it, { key: `${it.kind}:${it.g}:${it.x}`, left: PX(it.x) - L.nw / 2, top: Y(it.g), width: L.nw, height: L.nh, cx: PX(it.x) }));
  const labels = [];
  for (let g = gmin; g <= gmax; g += 1) if (BIG_COPY.rows[g]) labels.push({ text: BIG_COPY.rows[g], x: 8, y: Y(g) - 26, g });
  return {
    level: lv, size: L, nodes, strips, rings, labels,
    width: maxX - minX + 2 * PAD, height: Y(gmax) + L.nh + PAD, centre: { x: PX(0), y: Y(0) + L.nh / 2 },
    canShowGgp: model.ggp.some((z) => z.shared) || ggp
  };
}

/**
 * "See all": the faces-only layout, and whether it fits a {width, height} viewport. The tree is never scaled, so a family wider than the
 * viewport at 48 px still scrolls; `overflowX` and `overflowY` say by how much (0 when it fits).
 */
export function seeAll(model, opts, viewport) {
  const layout = bigLayout(model, 0, opts);
  const overflowX = Math.max(0, Math.ceil(layout.width - viewport.width));
  const overflowY = Math.max(0, Math.ceil(layout.height - viewport.height));
  return { level: 0, layout, fits: !overflowX && !overflowY, overflowX, overflowY };
}

/** The scroll offsets {left, top} that put the person in the middle of a {width, height} viewport, kept inside the canvas. */
export function scrollTarget(layout, viewport) {
  const clamp = (v, max) => Math.max(0, Math.min(v, Math.max(0, max)));
  return { left: clamp(layout.centre.x - viewport.width / 2, layout.width - viewport.width), top: clamp(layout.centre.y - viewport.height / 2, layout.height - viewport.height) };
}
