// The hourglass tree's geometry (HFY-TSK-379, flag familyVizHourglass; DIGEST sections 2, 6 and 7). PURE: numbers and plain records in, plain records
// out; no DOM, no fetch. A plain-DOM renderer reads these records and the model from hourglass-model.js and draws them, so no pass re-derives a
// position. Connectors are 2 px strips, {x, y, w, h, dashed, rep}, drawn under the cards (never SVG); `dashed` means "not known yet" or a
// half-brother's or half-sister's other marriage, `rep` (gold) means "the same people on both sides".
//
//   smallLayout(model, {width, kidsOpen, sibsOpen})   the small tree's rows for one content width (343 at a 375 phone, 288 at 320)
//   bigLayout(model, level, {sibsOpen, ggp})          the big tree: nodes, strips, rings, row labels, canvas size, the centre
//   seeAll(model, opts, viewport)                     "see all": the faces-only layout and whether it fits the viewport
//   scrollTarget(layout, viewport)                    where to scroll so the person sits in the middle of the viewport
//   comb(tops, drops, h, dashed, rep)                 the stem, bar and drops between two rows
//   defaultLevel(viewportWidth), SIZES                the four big-tree card sizes and the one a viewport starts at
//
// Spec numbers (T-Spec, DIGEST section 2): column gap 8 under 600 and 12 from 600; line strips 28 px between rows; the person's row is
// 1fr 1.4fr 1fr inside a band with 8 px padding and a 1 px border; four columns for grandparents and children, parents span two. The tree is
// never scaled: the four big sizes are real sizes, so a tap target never drops under 44 px.
import { COPY } from "./hourglass-model.js";

/** Line weight (tree.line.w), strip height between rows, wide breakpoint (the tree's own width), band inset (padding plus border), tap size. */
export const LINE = 2;
export const STRIP = 28;
export const WIDE_MIN = 600;
export const BAND_INSET = 9;
export const FACE = 44;
const RING = 10;
const PAD = 24;

/** The four big-tree sizes (T-Spec): faces only, small, medium, large. nw/nh card, gx/gy column and row gap, av photo, all px. */
export const SIZES = [
  { name: "faces only", nw: 48, nh: 48, gx: 6, gy: 60, av: 44 },
  { name: "small", nw: 128, nh: 184, gx: 12, gy: 64, av: 40 },
  { name: "medium", nw: 168, nh: 232, gx: 16, gy: 68, av: 56 },
  { name: "large", nw: 208, nh: 264, gx: 20, gy: 76, av: 72 }
];

/** The size a viewport starts at: medium from 700 px, else small. */
export const defaultLevel = (viewportWidth) => (viewportWidth >= 700 ? 2 : 1);

/**
 * A comb between two rows `h` apart: a stem down from each x in `tops` to the middle, one bar across them and `drops`, and a drop from the
 * middle to each x in `drops`. Strips are centred on their x. Returns [] when there is nothing to join.
 */
export function comb(tops, drops, h, dashed = false, rep = false) {
  const xs = [...tops, ...drops];
  if (!xs.length) return [];
  const ym = Math.round(h / 2);
  const mn = Math.min(...xs);
  const mx = Math.max(...xs);
  const out = [];
  if (mx - mn > 1) out.push({ x: mn - 1, y: ym - 1, w: mx - mn + 2, h: LINE, dashed, rep });
  for (const x of tops) out.push({ x: x - 1, y: 0, w: LINE, h: ym, dashed, rep });
  for (const x of drops) out.push({ x: x - 1, y: ym, w: LINE, h: h - ym, dashed, rep });
  return out;
}

/**
 * The small tree for a content width. Returns {width, wide, gap, colW, avatar, centres:{col, side, person}, rows}. `wide` is true from 600 px of
 * the tree's own width (768 and 1280 pages give it 670 and 710). Each row has a `kind`:
 *   note      {text, button}                       the "both sides" note, first
 *   cards     {cols, cells}                        a grid row; a cell is {item (card, ghost or chip; null is a spacer), col, span, row, x, w}
 *   gap       {h, strips}                          28 px between rows; the lines are placed from the column maths, so names can wrap
 *   band      {inset, innerW, toggle, siblings, person, also}   the sunken band: the brothers-and-sisters toggle, their cards when
 *             `sibsOpen`, the person's row (cells left to right: second partner, the person, first partner) and the "also with" chips
 *   toggle    {text, open}                         "+5 more children" / "show fewer"
 *   faces     {size, gap, perRow, items, more, names}  under 600: 44 px faces, the "+N" button and the names line
 *   actions   {openBig, aria, prefer, outline, table}
 * Cell x and w are px from the left edge of the tree, so tests can check that no two cells overlap and every one fits the width.
 */
export function smallLayout(model, { width, kidsOpen = false, sibsOpen = false }) {
  const W = width;
  const wide = W >= WIDE_MIN;
  const g = wide ? 12 : 8;
  const colW = (W - 3 * g) / 4;
  const c4 = (i) => i * (colW + g) + colW / 2;
  const side = (i) => (i === 0 ? colW + g / 2 : 2 * (colW + g) + colW + g / 2);
  const fcA = (W - 2 * BAND_INSET - 2 * g) / 3.4;
  const fc = [BAND_INSET + fcA / 2, W / 2, W - BAND_INSET - fcA / 2];
  const cell = (item, col, span = 1, row = 0, n = 4, x0 = 0, w0 = W) => {
    const cw = (w0 - (n - 1) * g) / n;
    return { item, col, span, row, x: x0 + col * (cw + g), w: span * cw + (span - 1) * g };
  };
  const rows = [];
  const gap = (strips) => rows.push({ kind: "gap", h: STRIP, strips });
  if (model.both.note) rows.push({ kind: "note", text: model.both.note.text, button: model.both.note.button });
  if (model.noParents) {
    rows.push({ kind: "cards", cols: 1, cells: [cell(model.parentsGhost, 0, 1, 0, 1)] });
    gap(comb([W / 2], [W / 2], STRIP, true));
  } else {
    const sideCells = [];
    const gpCells = [];
    const dashStrips = [];
    const solidStrips = [];
    model.sides.forEach((s, i) => {
      const col = i * 2;
      if (s.parent.ghost) { gpCells.push(cell(null, col, 2)); sideCells.push(cell(null, col, 2)); return; }
      sideCells.push(cell(s.caption, col, 2));
      if (!s.grandparents) { gpCells.push(cell(s.parentsGhost, col, 2)); dashStrips.push(...comb([side(i)], [side(i)], STRIP, true)); return; }
      const solid = [];
      const dash = [];
      s.grandparents.forEach((gp, j) => {
        gpCells.push(cell(gp, col + j));
        (gp.ghost ? dash : solid).push(c4(col + j));
      });
      if (dash.length) dashStrips.push(...comb(dash, [side(i)], STRIP, true));
      if (solid.length) solidStrips.push(...comb(solid, [side(i)], STRIP));
    });
    rows.push({ kind: "cards", cols: 4, cells: sideCells, sides: true });
    rows.push({ kind: "cards", cols: 4, cells: gpCells });
    gap([...dashStrips, ...solidStrips]);
    const pCells = model.sides.map((s, i) => cell(s.parent, i * 2, 2));
    rows.push({ kind: "cards", cols: 4, cells: pCells });
    const solid = model.sides.flatMap((s, i) => (s.parent.ghost ? [] : [side(i)]));
    const dash = model.sides.flatMap((s, i) => (s.parent.ghost ? [side(i)] : []));
    gap([...comb(dash, [W / 2], STRIP, true), ...comb(solid, [W / 2], STRIP)]);
  }
  // The band: brothers and sisters, the person, partners.
  const sibs = model.siblings;
  const sg = wide ? 4 : 3;
  const inner = W - 2 * BAND_INSET;
  const [p0, p1] = model.partners;
  const me = (item, col) => ({ item, col, span: 1, row: 0, x: BAND_INSET + (col === 0 ? 0 : col === 1 ? fcA + g : fcA + g + 1.4 * fcA + g), w: col === 1 ? 1.4 * fcA : fcA });
  rows.push({
    kind: "band", inset: BAND_INSET, innerW: inner,
    toggle: sibs.count ? { text: sibs.text, open: sibsOpen, aria: sibsOpen ? COPY.hideSiblings : COPY.showSiblings(sibs.text) } : null,
    siblings: sibsOpen && sibs.count ? { cols: sg, cells: sibs.list.map((s, i) => cell(s, i % sg, 1, Math.floor(i / sg), sg, BAND_INSET, inner)) } : null,
    person: { cols: [1, 1.4, 1], cells: [me(p1 || null, 0), me(model.focus, 1), me(p0 || null, 2)] },
    also: model.partners.slice(2)
  });
  // Children, in rows of four.
  const kids = model.children.list;
  if (kids.length) {
    const open = kidsOpen || kids.length <= model.children.cap;
    const shown = open ? kids : kids.slice(0, model.children.cap);
    const tops = new Set([W / 2]);
    for (const b of model.blocks) if (b.kids.length) { if (b.partner === 0) tops.add(fc[2]); if (b.partner === 1) tops.add(fc[0]); }
    gap(comb([...tops], shown.slice(0, 4).map((_, i) => c4(i)), STRIP));
    rows.push({ kind: "cards", cols: 4, cells: shown.map((k, i) => cell(k, i % 4, 1, Math.floor(i / 4))), rowGap: true });
    if (kids.length > model.children.cap) rows.push({ kind: "toggle", text: kidsOpen ? COPY.fewer : model.children.moreText, open: kidsOpen });
    // Grandchildren.
    const gk = model.grandchildren;
    if (gk.list.length) {
      const withKids = new Set(model.blocks.flatMap((b) => b.kids.filter((k) => k.grandchildren.length).map((k) => k.card.id)));
      const gTops = [];
      kids.forEach((k, i) => { if (i < 4 && shown.includes(k) && withKids.has(k.id)) gTops.push(c4(i)); });
      gap(comb(gTops.length ? gTops : [W / 2], [W / 2], STRIP));
      const vis = gk.list.slice(0, gk.shown);
      if (wide) {
        const cells = vis.map((c, i) => cell(c, i, 1, 0, 6));
        if (gk.more) cells.push(cell({ chip: true, text: COPY.moreChip(gk.more), aria: gk.moreAria }, vis.length, 1, 0, 6));
        rows.push({ kind: "cards", cols: 6, cells });
      } else {
        const n = vis.length + (gk.more ? 1 : 0);
        const fg = n > 1 ? Math.max(4, Math.min(g, Math.floor((W - n * FACE) / (n - 1)))) : g;
        rows.push({ kind: "faces", size: FACE, gap: fg, perRow: Math.max(1, Math.floor((W + fg) / (FACE + fg))), items: vis, more: gk.more ? { text: `+${gk.more}`, aria: gk.moreAria } : null, names: gk.namesText });
      }
    }
  }
  rows.push({ kind: "actions", openBig: COPY.openBig, aria: COPY.openBigAria(model.focus.name), prefer: COPY.prefer, outline: COPY.outline, table: COPY.table });
  return { width: W, wide, gap: g, colW, avatar: wide ? 44 : 32, centres: { col: [0, 1, 2, 3].map(c4), side: [side(0), side(1)], person: fc }, rows };
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

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
  const lv = Math.max(0, Math.min(3, Math.trunc(level) || 0));
  const L = SIZES[lv];
  const unit = L.nw + L.gx;
  const items = [];
  const add = (it) => { items.push(it); return it; };
  const person = (card, g, x) => add({ k: "person", card, g, x });
  const ghostItem = (gh, g, x) => add({ k: "ghost", g, x, text: gh.text, label: lv === 0 ? "?" : gh.text, tell: gh.tell && lv > 0 });
  person(model.focus, 0, 0);
  model.partners.forEach((c, i) => person(c, 0, i + 1));
  const sibs = model.siblings.list;
  const sibX = new Map();
  let sibLeft = [];
  if (sibs.length) {
    if (!sibsOpen) add({ k: "chip", g: 0, x: -1, role: "sibling", label: lv === 0 ? `+${sibs.length}` : model.siblings.text, aria: COPY.showSiblings(model.siblings.text), expanded: false, act: "sibs" });
    else {
      sibLeft = sibs.filter((s) => !(s.half && s.halfSide === 1));
      const sibRight = sibs.filter((s) => s.half && s.halfSide === 1);
      sibLeft.forEach((s, i) => { sibX.set(s.id, -(sibLeft.length - i)); person(s, 0, -(sibLeft.length - i)); });
      sibRight.forEach((s, i) => { sibX.set(s.id, model.partners.length + 1 + i); person(s, 0, model.partners.length + 1 + i); });
      add({ k: "chip", g: 0, x: -(sibLeft.length + 1), role: "sibling", label: lv === 0 ? "-" : "hide", aria: COPY.hideSiblings, expanded: true, act: "sibs" });
    }
  }
  // Parents, their other partners, grandparents.
  const slots = [];
  if (model.noParents) ghostItem(model.parentsGhost, -1, 0);
  else {
    model.sides.forEach((s) => {
      const x = s.i === 0 ? -0.5 : 0.5;
      const sl = { s, x, others: [], gp: null, gx: 0 };
      slots.push(sl);
      if (s.parent.ghost) ghostItem(s.parent, -1, x); else person(s.parent, -1, x);
      if (lv >= 2 && !s.parent.ghost) s.others.forEach((o, j) => { const ox = s.i === 0 ? -1.5 - j : 1.5 + j; sl.others.push({ o, x: ox }); person(o, -1, ox); });
    });
    for (const sl of slots) {
      if (sl.s.parent.ghost) continue;
      const base = sl.s.i === 0 ? -1 : 1;
      sl.gx = base;
      if (!sl.s.grandparents) { ghostItem(sl.s.parentsGhost, -2, base); continue; }
      sl.gp = sl.s.grandparents.map((gc, j) => {
        const x = base + (j === 0 ? -0.5 : 0.5);
        if (gc.ghost) ghostItem(gc, -2, x); else person(gc, -2, x);
        return { x, ghost: !!gc.ghost };
      });
    }
  }
  // Great-grandparents, once per union of a grandparent's parents; groups are pushed apart so they never overlap.
  const gg = [];
  if (ggp) {
    const groups = new Map();
    for (const it of items) {
      if (it.k !== "person" || it.g !== -2 || !it.card.up) continue;
      if (!groups.has(it.card.up)) groups.set(it.card.up, []);
      groups.get(it.card.up).push(it.x);
    }
    const list = [...groups].map(([unionId, kids]) => {
      const m = model.ggp.find((z) => z.unionId === unionId);
      const cards = m.slots.filter(Boolean);
      return { unionId, kids, cards, shared: m.shared, want: mean(kids), half: cards.length / 2 };
    }).filter((z) => z.cards.length).sort((a, b) => a.want - b.want);
    let edge = -Infinity;
    for (const z of list) { z.c = Math.max(z.want, edge + z.half); edge = z.c + z.half; }
    const drift = list.length ? list[list.length - 1].c - list[list.length - 1].want : 0;
    for (const z of list) {
      z.c -= drift / 2;
      z.xs = z.cards.length === 2 ? [z.c - 0.5, z.c + 0.5] : [z.c];
      z.cards.forEach((c, j) => person(c, -3, z.xs[j]));
      gg.push(z);
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
        add({ k: "chip", g: 2, x: gx, role: "grandchild", label: lv === 0 ? `+${k.more}` : COPY.moreChip(k.more), aria: COPY.moreOfChildren(k.more, k.k.card.first), act: "go", target: k.k.card.id });
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
  const seg = (x1, y1, x2, y2, dashed = false, rep = false) => {
    if (Math.abs(y1 - y2) < 0.5) strips.push({ x: Math.min(x1, x2) - 1, y: y1 - 1, w: Math.abs(x2 - x1) + 2, h: LINE, dashed, rep });
    else strips.push({ x: x1 - 1, y: Math.min(y1, y2), w: LINE, h: Math.abs(y2 - y1), dashed, rep });
  };
  const bottom = (x, g) => ({ x: PX(x), y: Y(g) + L.nh });
  const bracket = (xa, xb, g, k, dashed = false, rep = false) => {
    const y0 = Y(g) + L.nh;
    const yb = y0 + 10 + 7 * k;
    const a = PX(xa);
    const b = PX(xb);
    seg(a, y0, a, yb, dashed, rep); seg(b, y0, b, yb, dashed, rep); seg(a, yb, b, yb, dashed, rep);
    rings.push({ cx: (a + b) / 2, cy: yb, size: RING });
    return { x: (a + b) / 2, y: yb };
  };
  const hang = (mid, xs, gChild, k, dashed = false, rep = false) => {
    if (!xs.length) return;
    const yBar = Math.max(mid.y + 10, Y(gChild) - L.gy / 2 + 5 * k);
    const px = xs.map(PX);
    seg(mid.x, mid.y, mid.x, yBar, dashed, rep);
    const mn = Math.min(mid.x, ...px);
    const mx = Math.max(mid.x, ...px);
    if (mx - mn > 1) seg(mn, yBar, mx, yBar, dashed, rep);
    for (const x of px) seg(x, yBar, x, Y(gChild), dashed, rep);
  };
  if (model.noParents) seg(PX(0), Y(-1) + L.nh, PX(0), Y(0), true);
  else {
    const mid = bracket(-0.5, 0.5, -1, 0, slots.some((s) => s.s.parent.ghost));
    const full = [0];
    if (sibs.length && !sibsOpen) full.push(-1);
    for (const s of sibLeft) if (!s.half) full.push(sibX.get(s.id));
    hang(mid, full, 0, 0);
    for (const s of sibs) {
      if (!s.half || !sibX.has(s.id)) continue;
      const sl = slots[s.halfSide];
      const ot = sl.others.find((z) => z.o.unionIds.includes(s.unionId));
      hang(ot ? bracket(sl.x, ot.x, -1, 1, true) : bottom(sl.x, -1), [sibX.get(s.id)], 0, 1, true);
    }
    for (const sl of slots) {
      if (sl.s.parent.ghost) continue;
      if (sl.gp) { const dashed = sl.gp.some((z) => z.ghost); hang(bracket(sl.gp[0].x, sl.gp[1].x, -2, 0, dashed), [sl.x], -1, 0, dashed); }
      else hang(bottom(sl.gx, -2), [sl.x], -1, 0, true);
    }
    for (const z of gg) hang(z.xs.length === 2 ? bracket(z.xs[0], z.xs[1], -3, 0, false, z.shared) : bottom(z.xs[0], -3), z.kids, -2, 0, false, z.shared);
  }
  const mids = model.partners.map((_, i) => bracket(0, i + 1, 0, i));
  for (const bk of blocks) {
    hang(bk.px ? mids[bk.px - 1] : bottom(0, 0), bk.ks.map((k) => k.x), 1, bk.bi);
    for (const k of bk.ks) if (k.gxs.length) hang(bottom(k.x, 1), k.gxs, 2, 0);
  }
  // Nodes, in reading order.
  const nodes = items.sort((a, b) => a.g - b.g || a.x - b.x).map((it) => {
    const base = { key: `${it.k}:${it.g}:${it.x}`, kind: it.k, g: it.g, left: PX(it.x) - L.nw / 2, top: Y(it.g), width: L.nw, height: L.nh, cx: PX(it.x) };
    if (it.k === "ghost") return { ...base, text: it.text, label: it.label, tell: it.tell };
    if (it.k === "chip") return { ...base, role: it.role, label: it.label, aria: it.aria, expanded: it.expanded, act: it.act, target: it.target };
    const c = it.card;
    const current = c.id === model.id;
    return { ...base, card: c, role: c.role, name: lv >= 2 ? c.name : c.short, text: lv > 0, showBoth: c.both && lv > 0, current, aria: current ? c.ariaBig : c.aria };
  });
  const labels = [];
  for (let g = gmin; g <= gmax; g += 1) if (COPY.rows[g]) labels.push({ text: COPY.rows[g], x: 8, y: Y(g) - 26, g });
  return {
    level: lv, size: L, nodes, strips, rings, labels,
    width: maxX - minX + 2 * PAD, height: Y(gmax) + L.nh + PAD, centre: { x: PX(0), y: Y(0) + L.nh / 2 },
    canShowGgp: model.both.shared.length > 0 || ggp
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
