// The hourglass tree's small-tree geometry (HFY-TSK-379, flag familyVizHourglass; DIGEST sections 2, 6 and 7). PURE: numbers and plain records in, plain records
// out; no DOM, no fetch. A plain-DOM renderer reads these records and the model from hourglass-model.js and draws them, so no pass re-derives a
// position. Connectors are 2 px strips, {x, y, w, h, dashed, rep}, drawn under the cards (never SVG); `dashed` means "not known yet" or a
// half-brother's or half-sister's other marriage, `rep` (gold) means "the same people on both sides".
//
//   smallLayout(model, {width, kidsOpen, sibsOpen})   the small tree's rows for one content width (343 at a 375 phone, 288 at 320)
//   comb(tops, drops, h, dashed, rep)                 the stem, bar and drops between two rows
//
// The big tree (bigLayout, seeAll, scrollTarget, SIZES, defaultLevel) is in hourglass-big.js, so the person page's chunk never carries it.
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
