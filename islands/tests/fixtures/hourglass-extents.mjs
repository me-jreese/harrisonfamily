// Test-only (HFY-TSK-379): the pixel extents of the small tree's cells. The layout hands the renderer a column and a span per cell and lets CSS grid
// place it, so it carries no x or w; the tests still want to know that no two cells overlap and that every one fits the width, so this recomputes
// the grid exactly as the stylesheet declares it: four, six or three columns with the layout's gap, and the person's row at 1fr 1.4fr 1fr inside the band.
import { BAND_INSET, smallLayout } from "../../src/lib/hourglass-layout.js";

/** `smallLayout` plus `x` and `w` on every cell, `colW` and `avatar` on the layout, and spacer cells for the absent partners of the person's row. */
export function withExtents(L, W) {
  const g = L.wide ? 12 : 8;
  L.width = W;
  L.gap = g;
  // the column and person-row centres the connectors are drawn from, worked out here independently of the layout (T-Spec small-tree maths)
  const colW0 = (W - 3 * g) / 4;
  const c4 = (i) => i * (colW0 + g) + colW0 / 2;
  const fcA = (W - 2 * BAND_INSET - 2 * g) / 3.4;
  L.centres = { col: [0, 1, 2, 3].map(c4), side: [colW0 + g / 2, 2 * (colW0 + g) + colW0 + g / 2], person: [BAND_INSET + fcA / 2, W / 2, W - BAND_INSET - fcA / 2] };
  // the grid row of each cell: a column that does not move forward starts the next row
  const rows = (cells) => { let r = 0; let last = -1; for (const c of cells) { if (c.col <= last) r += 1; c.row = r; last = c.col; } };
  const grid = (cells, n, x0, w0) => {
    const cw = (w0 - (n - 1) * g) / n;
    for (const c of cells) { c.x = x0 + c.col * (cw + g); c.w = c.span * cw + (c.span - 1) * g; }
  };
  for (const row of L.rows) {
    if (row.kind === "cards") { rows(row.cells); grid(row.cells, row.cols, 0, W); }
    if (row.kind === "band") {
      if (row.siblings) { rows(row.siblings.cells); grid(row.siblings.cells, row.siblings.cols, BAND_INSET, W - 2 * BAND_INSET); }
      const at = [BAND_INSET, BAND_INSET + fcA + g, BAND_INSET + fcA + g + 1.4 * fcA + g];
      for (const c of row.person.cells) { c.x = at[c.col]; c.w = c.col === 1 ? 1.4 * fcA : fcA; }
      // the person's row as three cells, null for an absent partner, as the first pass drew it
      row.person.cols = [1, 1.4, 1];
      row.person.all = [0, 1, 2].map((i) => row.person.cells.find((c) => c.col === i) || { item: null, col: i, span: 1, row: 0, x: at[i], w: i === 1 ? 1.4 * fcA : fcA });
    }
  }
  L.colW = (W - 3 * g) / 4;
  L.avatar = L.wide ? 44 : 32;
  return L;
}

export const small = (model, opts) => withExtents(smallLayout(model, opts), opts.width);
