// The hourglass tree's small-tree rows (HFY-TSK-379, flag familyVizHourglass; DIGEST sections 2, 6 and 7). PURE: numbers and plain records in, plain
// records out; no DOM, no fetch. A plain-DOM renderer reads these records and the model from hourglass-model.js and draws them, so no pass
// re-derives a relationship or a line. CSS grid places the cards (a cell names its column and span), so the rows carry no pixel extents; the
// connectors are 2 px strips, {x, y, w, h, dashed, rep}, drawn under the cards (never SVG) from the same column maths the grid uses, so names
// can wrap without breaking a line. `dashed` means "not known yet" or a half-brother's or half-sister's other marriage, `rep` (gold) means
// "the same people on both sides".
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

/** Line weight (tree.line.w), strip height between rows, wide breakpoint (the tree's own width), band inset (padding plus border). */
export const LINE = 2;
export const STRIP = 28;
export const WIDE_MIN = 600;
export const BAND_INSET = 9;

/**
 * A comb between two rows `h` apart: a stem down from each x in `tops` to the middle, one bar across them and `drops`, and a drop from the
 * middle to each x in `drops`. Strips are centred on their x. Returns [] when there is nothing to join.
 */
export function comb(tops, drops, h, dashed = false, rep = false) {
  const xs = [...tops, ...drops];
  const ym = Math.round(h / 2);
  const mn = Math.min(...xs);
  const mx = Math.max(...xs);
  const s = (x, y, w, h2) => ({ x, y, w, h: h2, dashed, rep });
  return xs.length ? [...(mx - mn > 1 ? [s(mn - 1, ym - 1, mx - mn + 2, LINE)] : []), ...tops.map((x) => s(x - 1, 0, LINE, ym)), ...drops.map((x) => s(x - 1, ym, LINE, h - ym))] : [];
}

/**
 * The small tree for a content width. Returns {wide, rows}. `wide` is true from 600 px of the tree's own width (768 and 1280 pages give it 670 and
 * 710). Cells carry a column and a span, in reading order (a column that goes back starts the next grid row). Each row has a `kind`:
 *   note      {text, button}                       the "both sides" note, first
 *   cards     {cols, cells, sides?}                a grid row; a cell is {item (card, ghost, chip or a caption string), col, span}
 *   gap       {h, strips}                          28 px between rows
 *   band      {toggle, siblings, person, also}     the sunken band: the brothers-and-sisters toggle, their cards when `sibsOpen` ({cols, cells}), the
 *             person's row (`cells` in columns 0 to 2: second partner, the person, first partner; an absent partner has no cell) and the "also with" chips
 *   toggle    {text, open}                         "+5 more children" / "show fewer"
 *   faces     {items, more, names}                 under 600: 44 px faces, the "+N" button and the names line
 */
export function smallLayout(model, { width: W, kidsOpen = false, sibsOpen = false }) {
  const wide = W >= WIDE_MIN;
  const g = wide ? 12 : 8;
  const colW = (W - 3 * g) / 4;
  const c4 = (i) => i * (colW + g) + colW / 2;
  const side = (i) => colW + g / 2 + i * 2 * (colW + g);
  const fcA = (W - 2 * BAND_INSET - 2 * g) / 3.4;
  const fc = [BAND_INSET + fcA / 2, W / 2, W - BAND_INSET - fcA / 2];
  const cell = (item, col, span = 1) => ({ item, col, span });
  const rows = [];
  const gap = (strips) => rows.push({ kind: "gap", h: STRIP, strips });
  const cards = (cols, cells, more) => rows.push({ kind: "cards", cols, cells, ...more });
  if (model.both.note) rows.push({ kind: "note", text: model.both.note.text, button: model.both.note.button });
  if (model.noParents) {
    cards(1, [cell(model.parentsGhost, 0)]);
    gap(comb([W / 2], [W / 2], STRIP, true));
  } else {
    const caps = [];
    const gps = [];
    const solid = [];
    const dash = [];
    model.sides.forEach((s, i) => {
      if (s.parent.ghost) return;
      caps.push(cell(s.caption, i * 2, 2));
      if (!s.grandparents) { gps.push(cell(s.parentsGhost, i * 2, 2)); dash.push(...comb([side(i)], [side(i)], STRIP, true)); return; }
      const [k, d] = [[], []];
      s.grandparents.forEach((gp, j) => { gps.push(cell(gp, i * 2 + j)); (gp.ghost ? d : k).push(c4(i * 2 + j)); });
      if (d.length) dash.push(...comb(d, [side(i)], STRIP, true));
      if (k.length) solid.push(...comb(k, [side(i)], STRIP));
    });
    cards(4, caps, { sides: true });
    cards(4, gps);
    gap([...dash, ...solid]);
    cards(4, model.sides.map((s, i) => cell(s.parent, i * 2, 2)));
    const at = (ghost) => model.sides.flatMap((s, i) => (!!s.parent.ghost === ghost ? [side(i)] : []));
    gap([...comb(at(true), [W / 2], STRIP, true), ...comb(at(false), [W / 2], STRIP)]);
  }
  // The band: brothers and sisters, the person, partners.
  const sibs = model.siblings;
  const sg = wide ? 4 : 3;
  const [p0, p1] = model.partners;
  rows.push({
    kind: "band",
    toggle: sibs.count ? { text: sibs.text, open: sibsOpen, aria: sibsOpen ? COPY.hideSiblings : COPY.showSiblings(sibs.text) } : null,
    siblings: sibsOpen && sibs.count ? { cols: sg, cells: sibs.list.map((s, i) => cell(s, i % sg)) } : null,
    person: { cells: [p1 && cell(p1, 0), cell(model.focus, 1), p0 && cell(p0, 2)].filter(Boolean) },
    also: model.partners.slice(2)
  });
  // Children, in rows of four, then the grandchildren.
  const kids = model.children.list;
  if (kids.length) {
    const shown = kidsOpen || kids.length <= model.children.cap ? kids : kids.slice(0, model.children.cap);
    const tops = new Set([W / 2]);
    for (const b of model.blocks) if (b.kids.length && b.partner >= 0 && b.partner < 2) tops.add(fc[2 - b.partner * 2]);
    gap(comb([...tops], shown.slice(0, 4).map((_, i) => c4(i)), STRIP));
    cards(4, shown.map((k, i) => cell(k, i % 4)));
    if (kids.length > model.children.cap) rows.push({ kind: "toggle", text: kidsOpen ? COPY.fewer : model.children.moreText, open: kidsOpen });
    const gk = model.grandchildren;
    if (gk.list.length) {
      const parents = new Set(gk.list.map((c) => c.parent));
      const tops2 = shown.slice(0, 4).flatMap((k, i) => (parents.has(k.id) ? [c4(i)] : []));
      gap(comb(tops2.length ? tops2 : [W / 2], [W / 2], STRIP));
      const vis = gk.list.slice(0, gk.shown);
      if (wide) cards(6, [...vis, ...(gk.more ? [{ chip: true, text: COPY.moreChip(gk.more), aria: gk.moreAria }] : [])].map((c, i) => cell(c, i)));
      else rows.push({ kind: "faces", items: vis, more: gk.more ? { text: `+${gk.more}`, aria: gk.moreAria } : null, names: gk.namesText });
    }
  }
  return { wide, rows };
}
