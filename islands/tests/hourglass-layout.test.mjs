// HFY-TSK-379 pass 1: the hourglass tree's geometry (lib/hourglass-layout.js, and lib/hourglass-big.js for the big tree) on the invented people of fixtures/tree-graph-hourglass.json.
// Plain `node --test`, no browser. The small tree is checked at the content widths of the four viewports the boards use (320 gives 288, 375 gives
// 343, 768 gives 670, 1280 gives 710), the big tree at its four sizes: no two cards overlap, everything sits inside the width or the canvas,
// the numbers are the spec's (T-Spec, DIGEST section 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { indexGraph, familyModel, COPY } from "../src/lib/hourglass-model.js";
import { BAND_INSET, FACE, LINE, STRIP, comb, smallLayout } from "../src/lib/hourglass-layout.js";
import { SIZES, bigLayout, defaultLevel, scrollTarget, seeAll } from "../src/lib/hourglass-big.js";
import { CASES, GRAPH } from "./fixtures/hourglass-cases.mjs";

const idx = indexGraph(GRAPH);
const model = (c) => familyModel(idx, CASES[c]);
const WIDTHS = { 320: 288, 375: 343, 768: 670, 1280: 710 };
const EPS = 1e-6;

const rowsOf = (layout, kind) => layout.rows.filter((r) => r.kind === kind);
const kinds = (layout) => layout.rows.map((r) => r.kind);
const cellsOf = (row) => (row.cells || []).filter((c) => c.item);
const stripKey = (s) => `${s.x},${s.y},${s.w},${s.h}${s.dashed ? ",dashed" : ""}${s.rep ? ",rep" : ""}`;

function assertNoOverlap(cells, W, label) {
  const byRow = new Map();
  for (const c of cells) { const k = c.row; byRow.set(k, [...(byRow.get(k) || []), c]); }
  for (const [, list] of byRow) {
    const sorted = list.slice().sort((a, b) => a.x - b.x);
    for (let i = 0; i < sorted.length; i += 1) {
      assert.ok(sorted[i].x >= -EPS && sorted[i].x + sorted[i].w <= W + EPS, `${label}: a cell leaves 0..${W}: x ${sorted[i].x} w ${sorted[i].w}`);
      assert.ok(sorted[i].w > 0, `${label}: a cell has no width`);
      if (i) assert.ok(sorted[i].x >= sorted[i - 1].x + sorted[i - 1].w - EPS, `${label}: two cells overlap in a row`);
    }
  }
}

function assertSmallGeometry(layout, label) {
  const W = layout.width;
  for (const row of layout.rows) {
    if (row.cells) assertNoOverlap(row.cells, W, `${label} ${row.kind}`);
    if (row.kind === "band") {
      assertNoOverlap(row.person.cells, W, `${label} band person`);
      if (row.siblings) assertNoOverlap(row.siblings.cells, W, `${label} band siblings`);
      for (const c of [...row.person.cells, ...(row.siblings ? row.siblings.cells : [])]) assert.ok(c.x >= BAND_INSET - EPS && c.x + c.w <= W - BAND_INSET + EPS, `${label}: a band cell leaves the band`);
    }
    if (row.kind === "gap") {
      assert.equal(row.h, STRIP);
      for (const s of row.strips) {
        assert.ok(s.x >= -EPS && s.x + s.w <= W + EPS, `${label}: a strip leaves the width: ${stripKey(s)}`);
        assert.ok(s.y >= -EPS && s.y + s.h <= row.h + EPS, `${label}: a strip leaves its gap: ${stripKey(s)}`);
        assert.ok(Math.min(s.w, s.h) === LINE, `${label}: strips are ${LINE}px: ${stripKey(s)}`);
        assert.equal(typeof s.dashed, "boolean");
      }
    }
    if (row.kind === "faces") {
      const n = row.items.length + (row.more ? 1 : 0);
      assert.ok(n * row.size + (n - 1) * row.gap <= W + EPS || row.perRow < n, `${label}: the faces fit one row or wrap`);
    }
  }
}

test("comb: stems, one bar and drops, 2 px strips centred on their x", () => {
  assert.deepEqual(comb([], [], 28), []);
  const c = comb([40], [20, 60], 28);
  assert.deepEqual(c.map(stripKey), ["19,13,42,2", "39,0,2,14", "19,14,2,14", "59,14,2,14"]);
  assert.deepEqual(comb([50], [50], 28).map(stripKey), ["49,0,2,14", "49,14,2,14"], "no bar for a straight line");
  assert.ok(comb([40], [20], 28, true, true).every((s) => s.dashed && s.rep));
});

test("the small tree at 375: four columns of 79.75 with 8 px gaps, parents span two, the person's row is 1 : 1.4 : 1", () => {
  const m = model("full");
  const L = smallLayout(m, { width: WIDTHS[375] });
  assert.equal(L.wide, false);
  assert.equal(L.gap, 8);
  assert.equal(L.avatar, 32);
  assert.ok(Math.abs(L.colW - 79.75) < EPS, "(343 - 3 * 8) / 4");
  assert.deepEqual(kinds(L), ["cards", "cards", "gap", "cards", "gap", "band", "gap", "cards", "gap", "faces", "actions"]);
  const [sides, gps, , parents] = L.rows;
  assert.deepEqual(sides.cells.map((c) => [c.item, c.col, c.span]), [["father's side", 0, 2], ["mother's side", 2, 2]]);
  assert.deepEqual(gps.cells.map((c) => c.col), [0, 1, 2, 3]);
  assert.ok(Math.abs(gps.cells[1].x - 87.75) < EPS && Math.abs(gps.cells[1].w - 79.75) < EPS);
  assert.deepEqual(parents.cells.map((c) => [c.col, c.span]), [[0, 2], [2, 2]]);
  assert.ok(Math.abs(parents.cells[0].w - (2 * 79.75 + 8)) < EPS, "a parent is two columns and the gap between");
  // each parent sits under the midpoint of their own parents
  assert.ok(Math.abs(L.centres.side[0] - (gps.cells[0].x + gps.cells[1].x + gps.cells[1].w) / 2) < EPS);
  assert.ok(Math.abs(L.centres.side[1] - (gps.cells[2].x + gps.cells[3].x + gps.cells[3].w) / 2) < EPS);
  const band = rowsOf(L, "band")[0];
  assert.deepEqual(band.person.cols, [1, 1.4, 1]);
  const [left, mid, right] = band.person.cells;
  assert.ok(Math.abs(mid.w / left.w - 1.4) < 1e-9 && Math.abs(right.w - left.w) < EPS);
  assert.equal(left.item, null, "no second partner: a spacer");
  assert.equal(mid.item.id, m.focus.id);
  assert.equal(right.item.name, "Hugo Larkspur", "the first partner is on the right");
  assert.ok(Math.abs(mid.x + mid.w / 2 - 343 / 2) < EPS, "the person is in the middle");
  assert.ok(Math.abs(L.centres.person[1] - 171.5) < EPS);
  assert.ok(Math.abs(L.centres.person[0] - (BAND_INSET + (343 - 18 - 16) / 3.4 / 2)) < EPS);
  // father's side and mother's side captions on the band's grandparents' row, in order
  assert.deepEqual(rowsOf(L, "cards")[0].sides, true);
});

test("the small tree at every width: no overlaps, nothing past the width, 28 px gaps, 2 px strips", () => {
  for (const [vw, W] of Object.entries(WIDTHS)) {
    for (const [name, id] of Object.entries(CASES)) {
      const m = familyModel(idx, id);
      for (const open of [false, true]) {
        const L = smallLayout(m, { width: W, kidsOpen: open, sibsOpen: open });
        assert.equal(L.width, W);
        assertSmallGeometry(L, `${name} at ${vw}${open ? " opened" : ""}`);
      }
    }
  }
});

test("the gap between columns is 8 under 600 and 12 from 600; the grandchildren are faces below, a six-column card row from there", () => {
  const m = model("full");
  const narrow = smallLayout(m, { width: 599 });
  const wide = smallLayout(m, { width: 600 });
  assert.deepEqual([narrow.wide, narrow.gap, wide.wide, wide.gap], [false, 8, true, 12]);
  assert.deepEqual([narrow.avatar, wide.avatar], [32, 44]);
  assert.equal(rowsOf(narrow, "faces").length, 1);
  assert.equal(rowsOf(narrow, "cards").filter((r) => r.cols === 6).length, 0);
  const six = rowsOf(wide, "cards").filter((r) => r.cols === 6);
  assert.equal(six.length, 1);
  assert.equal(rowsOf(wide, "faces").length, 0);
  assert.equal(six[0].cells.length, 3);
  assert.deepEqual(six[0].cells.map((c) => c.col), [0, 1, 2]);
  assert.ok(Math.abs(six[0].cells[0].w - (600 - 5 * 12) / 6) < EPS, "six columns with 12 px gaps");
  assert.deepEqual(wide.rows.map((r) => r.kind).slice(-3), ["gap", "cards", "actions"]);
  // faces: 44 px, with the names line the model wrote
  const f = rowsOf(narrow, "faces")[0];
  assert.equal(f.size, FACE);
  assert.deepEqual(f.items.map((c) => c.name), ["Ivy Hollin", "Jory Hollin", "Kit Larkspur"]);
  assert.equal(f.names, "grandchildren: Ivy, Jory and Kit");
  assert.equal(f.more, null);
});

test("six grandchild faces still fit one row at 320 (288 px): 6 x 44 plus five gaps of 4", () => {
  const m = model("large");
  const L = smallLayout(m, { width: WIDTHS[320] });
  const f = rowsOf(L, "faces")[0];
  assert.equal(f.items.length, 5);
  assert.deepEqual(f.more, { text: "+4", aria: "4 more grandchildren. open the big tree" });
  assert.equal(f.gap, 4);
  assert.ok(6 * f.size + 5 * f.gap <= 288);
  assert.equal(f.perRow, 6);
  const at375 = rowsOf(smallLayout(m, { width: WIDTHS[375] }), "faces")[0];
  assert.equal(at375.gap, 8, "the gap grows back to the column gap when there is room");
  const wide = rowsOf(smallLayout(m, { width: WIDTHS[768] }), "cards").filter((r) => r.cols === 6)[0];
  assert.equal(wide.cells.length, 6);
  assert.deepEqual(wide.cells[5].item, { chip: true, text: "+4 more", aria: "4 more grandchildren. open the big tree" }, "five cards and a '+n more' chip");
});

test("case: a large family. four children and '+5 more children'; opened, the rest wrap in rows of four", () => {
  const m = model("large");
  const closed = smallLayout(m, { width: 343 });
  const kids = rowsOf(closed, "cards").find((r) => r.cells.length && r.cells[0].item.role === "child");
  assert.equal(kids.cells.length, 4);
  assert.deepEqual(rowsOf(closed, "toggle"), [{ kind: "toggle", text: "+5 more children", open: false }]);
  const open = smallLayout(m, { width: 343, kidsOpen: true });
  const all = rowsOf(open, "cards").find((r) => r.cells.length && r.cells[0].item.role === "child");
  assert.equal(all.cells.length, 9);
  assert.deepEqual(all.cells.map((c) => [c.row, c.col]), [[0, 0], [0, 1], [0, 2], [0, 3], [1, 0], [1, 1], [1, 2], [1, 3], [2, 0]]);
  assert.deepEqual(rowsOf(open, "toggle"), [{ kind: "toggle", text: "show fewer", open: true }]);
  // The comb to the children drops on the first four columns only.
  const gap = open.rows[open.rows.indexOf(all) - 1];
  const drops = gap.strips.filter((s) => s.y >= STRIP / 2 && s.w === LINE).map((s) => s.x + 1);
  assert.deepEqual(drops.map((x) => Math.round(x * 100) / 100), open.centres.col.map((x) => Math.round(x * 100) / 100));
  // A family of four or fewer has no toggle.
  assert.equal(rowsOf(smallLayout(model("full"), { width: 343 }), "toggle").length, 0);
});

test("case: no parents. one dashed ghost, a dashed stem, and no grandparent row", () => {
  const L = smallLayout(model("noParents"), { width: 343 });
  assert.deepEqual(kinds(L).slice(0, 3), ["cards", "gap", "band"]);
  assert.equal(L.rows[0].cols, 1);
  assert.deepEqual([L.rows[0].cells[0].x, L.rows[0].cells[0].w], [0, 343]);
  assert.equal(L.rows[0].cells[0].item.text, "parents not known yet.");
  assert.deepEqual(L.rows[1].strips.map(stripKey), ["170.5,0,2,14,dashed", "170.5,14,2,14,dashed"], "one dashed stem at the middle");
  assert.equal(rowsOf(L, "band")[0].toggle, null, "no brothers and sisters, no toggle");
});

test("case: one parent. the unknown side is a spacer with a dashed stem; the known side keeps its captions and combs", () => {
  const L = smallLayout(model("oneParent"), { width: 343 });
  const [sides, gps, gap1, parents, gap2] = L.rows;
  assert.deepEqual(sides.cells.map((c) => [c.item, c.col]), [[null, 0], ["mother's side", 2]]);
  assert.equal(gps.cells[0].item, null);
  assert.equal(gps.cells[0].span, 2);
  assert.deepEqual(gps.cells.slice(1).map((c) => c.item.name), ["Barnaby Meadowby", "Coralie Northam"]);
  assert.equal(gap1.strips.every((s) => !s.dashed), true);
  assert.equal(parents.cells[0].item.text, "father not known yet.");
  assert.equal(parents.cells[0].span, 2);
  const dashed = gap2.strips.filter((s) => s.dashed);
  assert.ok(dashed.length >= 1, "the missing parent's line is dashed");
  assert.equal(gap2.strips.some((s) => !s.dashed), true, "the known parent's line is solid");
});

test("case: brothers and sisters opened. a toggle in the band, three columns of cards under 600 and four from 600", () => {
  const m = model("siblings");
  const closed = rowsOf(smallLayout(m, { width: 343 }), "band")[0];
  assert.deepEqual(closed.toggle, { text: "6 brothers and sisters", open: false, aria: "6 brothers and sisters. show them" });
  assert.equal(closed.siblings, null);
  const open = rowsOf(smallLayout(m, { width: 343, sibsOpen: true }), "band")[0];
  assert.deepEqual(open.toggle, { text: "6 brothers and sisters", open: true, aria: "hide brothers and sisters" });
  assert.equal(open.siblings.cols, 3);
  assert.deepEqual(open.siblings.cells.map((c) => [c.row, c.col]), [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]]);
  assert.deepEqual(open.siblings.cells.map((c) => c.item.half), [false, false, true, true, true, true]);
  const wide = rowsOf(smallLayout(m, { width: 670, sibsOpen: true }), "band")[0];
  assert.equal(wide.siblings.cols, 4);
  assert.deepEqual(wide.siblings.cells.map((c) => [c.row, c.col]), [[0, 0], [0, 1], [0, 2], [0, 3], [1, 0], [1, 1]]);
  // The mother's parents are not recorded: her side is one ghost spanning two columns with a dashed stem.
  const L = smallLayout(m, { width: 343 });
  assert.equal(L.rows[1].cells[2].item.text, "her parents not known yet.");
  assert.equal(L.rows[1].cells[2].span, 2);
  assert.ok(L.rows[2].strips.some((s) => s.dashed));
});

test("case: the same ancestors on both sides. the note is the first row, and the grandparents who are brother and sister are tagged", () => {
  const L = smallLayout(model("pedigree"), { width: 343 });
  assert.equal(L.rows[0].kind, "note");
  assert.match(L.rows[0].text, /^Delphine and Everett were sister and brother, so /);
  assert.equal(L.rows[0].button, "see them in the big tree");
  assert.deepEqual(L.rows[2].cells.filter((c) => c.item.both).map((c) => c.item.name), ["Delphine Eastlake", "Everett Eastlake"]);
  assert.equal(kinds(smallLayout(model("full"), { width: 343 }))[0], "cards", "no note for a family that is not on both sides");
});

test("case: several partners. the first on the right, the second on the left, the rest as chips; the children comb starts at each partner", () => {
  const m = model("partners");
  const L = smallLayout(m, { width: 343 });
  const band = rowsOf(L, "band")[0];
  // The mother's parents are recorded by the mother alone: a ghost in the father slot and a dashed line from it, a solid one from her.
  assert.equal(L.rows[1].cells[1].item.text, "not known yet.");
  assert.equal(L.rows[1].cells[2].item.name, "Odalys Fennick");
  assert.ok(L.rows[2].strips.some((s) => s.dashed) && L.rows[2].strips.some((s) => !s.dashed));
  assert.equal(band.person.cells[2].item.name, "Alma Pennywell");
  assert.equal(band.person.cells[0].item.name, "Beatrix Oakley");
  assert.deepEqual(band.also.map((p) => [p.name, p.word]), [["Cleo Fennick", "partner"], ["Dale Ivorton", "partner"]]);
  const kidsRow = L.rows.findIndex((r) => r.kind === "cards" && r.cells.length === 3 && r.cells[0].item.role === "child");
  const tops = L.rows[kidsRow - 1].strips.filter((s) => s.y === 0).map((s) => s.x + 1).sort((a, b) => a - b);
  assert.deepEqual(tops.map((x) => Math.round(x * 100) / 100), [L.centres.person[0], 343 / 2, L.centres.person[2]].map((x) => Math.round(x * 100) / 100), "the person's own and both partners' centres");
});

test("a person with one partner and children: the comb hangs from the person and that partner", () => {
  const L = smallLayout(model("full"), { width: 343 });
  const gap = L.rows[L.rows.findIndex((r) => r.kind === "band") + 1];
  const tops = gap.strips.filter((s) => s.y === 0).map((s) => s.x + 1).sort((a, b) => a - b);
  assert.deepEqual(tops.map((x) => Math.round(x * 100) / 100), [171.5, Math.round(L.centres.person[2] * 100) / 100]);
});

test("a person with nobody around them: only the person's band and the actions", () => {
  const L = smallLayout(model("alone"), { width: 343 });
  assert.deepEqual(kinds(L), ["cards", "gap", "band", "actions"]);
  assert.equal(model("alone").empty, true);
  assert.deepEqual(L.rows.at(-1), { kind: "actions", openBig: "open the big tree", aria: "open the big tree, centred on Isolde Cobbler", prefer: "prefer a list?", outline: "outline", table: "table" });
});

// ---- the big tree ----

function assertBigGeometry(L, label) {
  const rows = new Map();
  for (const n of L.nodes) {
    assert.ok(n.left >= -EPS && n.top >= -EPS && n.left + n.width <= L.width + EPS && n.top + n.height <= L.height + EPS, `${label}: a node leaves the canvas (${n.kind} ${n.key})`);
    assert.equal(n.width, L.size.nw);
    assert.equal(n.height, L.size.nh);
    rows.set(n.g, [...(rows.get(n.g) || []), n]);
  }
  for (const [g, list] of rows) {
    const sorted = list.slice().sort((a, b) => a.left - b.left);
    for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i].left >= sorted[i - 1].left + sorted[i - 1].width + L.size.gx - EPS, `${label}: row ${g} has two cards closer than the column gap`);
  }
  for (const s of L.strips) {
    assert.ok(s.x >= -EPS && s.y >= -EPS && s.x + s.w <= L.width + EPS && s.y + s.h <= L.height + EPS, `${label}: a strip leaves the canvas: ${stripKey(s)}`);
    assert.equal(Math.min(s.w, s.h), LINE, `${label}: strips are 2px: ${stripKey(s)}`);
  }
  for (const r of L.rings) assert.ok(r.cx > 0 && r.cx < L.width && r.cy > 0 && r.cy < L.height && r.size === 10);
  // reading order: ancestors, the person's row, descendants, each row left to right
  const order = L.nodes.map((n) => [n.g, n.cx]);
  assert.deepEqual(order, order.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]), `${label}: DOM order`);
  assert.deepEqual(new Set(L.nodes.map((n) => n.key)).size, L.nodes.length, `${label}: node keys are unique`);
}

test("the four sizes are the spec's, and a node is exactly that size at that level", () => {
  assert.deepEqual(SIZES.map((s) => [s.name, s.nw, s.nh, s.gx, s.gy, s.av]), [["faces only", 48, 48, 6, 60, 44], ["small", 128, 184, 12, 64, 40], ["medium", 168, 232, 16, 68, 56], ["large", 208, 264, 20, 76, 72]]);
  const m = model("full");
  SIZES.forEach((s, lv) => {
    const L = bigLayout(m, lv, {});
    assert.equal(L.level, lv);
    assert.deepEqual([L.nodes[0].width, L.nodes[0].height], [s.nw, s.nh]);
    assert.equal(L.size, s);
  });
  assert.equal(bigLayout(m, -4, {}).level, 0);
  assert.equal(bigLayout(m, 9, {}).level, 3);
  assert.equal(defaultLevel(375), 1);
  assert.equal(defaultLevel(699), 1);
  assert.equal(defaultLevel(700), 2);
  assert.equal(defaultLevel(1280), 2);
});

test("the big tree: no overlaps at any size, for every case, with the brothers and sisters and great-grandparents opened or not", () => {
  for (const [name, id] of Object.entries(CASES)) {
    const m = familyModel(idx, id);
    for (let lv = 0; lv <= 3; lv += 1) {
      for (const sibsOpen of [false, true]) for (const ggp of [false, true]) assertBigGeometry(bigLayout(m, lv, { sibsOpen, ggp }), `${name} level ${lv} sibs ${sibsOpen} ggp ${ggp}`);
    }
  }
});

test("the big tree: every person of the fixture lays out at every size", () => {
  for (const p of GRAPH.people) {
    const m = familyModel(idx, p.id);
    for (let lv = 0; lv <= 3; lv += 1) assertBigGeometry(bigLayout(m, lv, { sibsOpen: true, ggp: true }), `${p.id} level ${lv}`);
  }
});

test("rows by generation: the person at 0, partners to the right, parents above, children and grandchildren below; labels name the rows", () => {
  const m = model("full");
  const L = bigLayout(m, 2, {});
  const at = (g) => L.nodes.filter((n) => n.g === g).map((n) => n.card?.name ?? n.label);
  assert.deepEqual(at(-2), ["Silas Alder", "Mabry Fennick", "Edmund Birchwood", "Hester Ivorton"]);
  assert.deepEqual(at(-1), ["Rowan Alder", "Delia Birchwood"]);
  assert.deepEqual(at(0), ["1 brother", "Tamsin Alder", "Hugo Larkspur"]);
  assert.deepEqual(at(1), ["Wren Larkspur", "Orrin Larkspur", "Sefa Larkspur"]);
  assert.deepEqual(at(2), ["Ivy Hollin", "Jory Hollin", "Kit Larkspur"]);
  assert.deepEqual(L.labels.map((l) => l.text), ["grandparents", "parents", "children", "grandchildren"]);
  assert.ok(L.labels.every((l) => l.x === 8));
  const me = L.nodes.find((n) => n.current);
  assert.equal(me.card.id, m.focus.id);
  assert.equal(me.aria, "Tamsin Alder, in the middle now");
  assert.equal(L.nodes.filter((n) => n.current).length, 1);
  assert.deepEqual(L.centre, { x: me.cx, y: me.top + me.height / 2 });
  assert.equal(L.nodes.find((n) => n.card?.name === "Rowan Alder").aria, "Rowan Alder, father");
  // children and grandchildren hang from the union: the partner's bracket carries a ring
  assert.ok(L.rings.length >= 3, "parents, partner and grandparents brackets");
});

test("text: names are short below medium and full from medium; faces only has no text; the 'both sides' tag shows from small", () => {
  const m = model("pedigree");
  const names = (lv) => bigLayout(m, lv, {}).nodes.find((n) => n.card?.name === "Delphine Eastlake");
  assert.deepEqual([names(0).text, names(1).text], [false, true]);
  assert.equal(names(1).name, "Delphine Eastlake");
  const long = familyModel(idx, CASES.large);
  const kid = (lv) => bigLayout(long, lv, {}).nodes.find((n) => n.card?.name.startsWith("Evangeline"));
  assert.equal(kid(1).name, "Evangeline Thistledown-Pennywell");
  assert.equal(kid(2).name, "Evangeline Marguerite Rosamund Thistledown-Pennywell");
  assert.deepEqual([names(0).showBoth, names(1).showBoth, names(2).showBoth], [false, true, true]);
});

test("the parents' other partners show from medium up, never below", () => {
  const m = model("partners");
  const others = (lv) => bigLayout(m, lv, {}).nodes.filter((n) => n.g === -1).map((n) => n.card?.name);
  assert.deepEqual(others(1), ["Edric Dunmere", "Marta Fennick"]);
  assert.deepEqual(others(2), ["Fern Oakley", "Edric Dunmere", "Marta Fennick", "Rolf Cobbler"]);
  assert.deepEqual(others(3), others(2));
  const L = bigLayout(m, 2, {});
  assert.equal(L.nodes.find((n) => n.card?.name === "Fern Oakley").card.word, "stepmother");
  assert.equal(L.nodes.find((n) => n.card?.name === "Rolf Cobbler").card.word, "mother's partner");
});

test("all partners sit in the person's row: the first right beside the person, each union with its own bracket, 7 px lower each time", () => {
  const m = model("partners");
  const L = bigLayout(m, 2, {});
  const row0 = L.nodes.filter((n) => n.g === 0);
  const me = row0.find((n) => n.current);
  assert.deepEqual(row0.filter((n) => n.left > me.left).map((n) => n.card.name), ["Alma Pennywell", "Beatrix Oakley", "Cleo Fennick", "Dale Ivorton"]);
  const ys = L.rings.filter((r) => r.cy > me.top + me.height && r.cy < me.top + me.height + 60).map((r) => r.cy).sort((a, b) => a - b);
  assert.deepEqual(ys.map((y, i) => y - ys[0]), [0, 7, 14, 21], "bracket depth 10 + 7k");
  assert.equal(ys[0] - (me.top + me.height), 10);
});

test("half brothers and sisters hang dashed; full ones solid; the dashed line leaves the shared parent's other union at medium and up", () => {
  const m = model("siblings");
  const dashedAt = (lv, sibsOpen) => bigLayout(m, lv, { sibsOpen }).strips.filter((s) => s.dashed).length;
  assert.ok(dashedAt(2, true) > dashedAt(2, false), "opened: the half brothers and sisters add dashed lines");
  assert.ok(dashedAt(1, true) > dashedAt(1, false), "below medium the other partner is not shown, the dashed line leaves the parent's card");
  const full = model("full");
  assert.equal(bigLayout(full, 2, { sibsOpen: true }).strips.filter((s) => s.dashed).length, 0, "full brothers and sisters hang solid from the parents' bracket");
  const L = bigLayout(m, 2, { sibsOpen: true });
  assert.ok(L.rings.length >= 4, "the parents' bracket, a dashed bracket to each other partner, grandparents");
  // full siblings are on the left of the person with the father's half siblings; the mother's half siblings after the partners
  const row0 = L.nodes.filter((n) => n.g === 0 && n.kind === "person").map((n) => n.card.name);
  assert.deepEqual(row0, ["Cecily Kestrel", "Emrys Kestrel", "Gareth Kestrel", "Hilda Kestrel", "Dorian Kestrel", "Jessamy Rowanford", "Kai Rowanford"]);
  assert.equal(row0.indexOf("Dorian Kestrel"), 4, "four on the left");
  assert.deepEqual(row0.slice(5), ["Jessamy Rowanford", "Kai Rowanford"], "the mother's half siblings to the right");
  const chips = L.nodes.filter((n) => n.kind === "chip");
  assert.deepEqual(chips.map((c) => [c.label, c.aria, c.expanded, c.act]), [["hide", "hide brothers and sisters", true, "sibs"]]);
  assert.equal(L.nodes.find((n) => n.kind === "chip").left < L.nodes.find((n) => n.card?.name === "Cecily Kestrel").left, true, "the hide chip is the leftmost");
  const closed = bigLayout(m, 2, {}).nodes.filter((n) => n.kind === "chip");
  assert.deepEqual(closed.map((c) => [c.label, c.aria, c.expanded]), [["6 brothers and sisters", "6 brothers and sisters. show them", false]]);
  assert.equal(bigLayout(m, 0, {}).nodes.find((n) => n.kind === "chip").label, "+6", "at faces only: +N");
  assert.equal(bigLayout(m, 0, { sibsOpen: true }).nodes.find((n) => n.kind === "chip").label, "-");
});

test("a child with more than three grandchildren shows two and a '+n more' chip that puts that child in the middle", () => {
  const m = model("large");
  const L = bigLayout(m, 2, {});
  const chips = L.nodes.filter((n) => n.kind === "chip");
  assert.deepEqual(chips.map((c) => [c.label, c.act, c.g]), [["+2 more", "go", 2]]);
  assert.equal(chips[0].aria, "2 more of Olwen's children. put Olwen in the middle");
  assert.equal(chips[0].target, m.children.list.find((c) => c.first === "Olwen").id);
  assert.equal(L.nodes.filter((n) => n.g === 2 && n.kind === "person").length, 3 + 2 + 2, "three, two and two, with the two of the fourth child");
  assert.equal(bigLayout(m, 0, {}).nodes.find((n) => n.kind === "chip").label, "+2");
  assert.equal(L.nodes.filter((n) => n.g === 1).length, 9, "the big tree shows all nine children");
});

test("a child with no grandchildren is one card wide; grandchildren sit under their parent; blocks never overlap", () => {
  const L = bigLayout(model("partners"), 1, {});
  const kids = L.nodes.filter((n) => n.g === 1).map((n) => n.cx);
  for (let i = 1; i < kids.length; i += 1) assert.ok(kids[i] - kids[i - 1] >= L.size.nw + L.size.gx - EPS);
});

test("great-grandparents: off by default, drawn once with gold lines to both grandparents when shared", () => {
  const m = model("pedigree");
  const off = bigLayout(m, 2, {});
  assert.equal(off.nodes.filter((n) => n.g === -3).length, 0);
  assert.equal(off.canShowGgp, true, "shared ancestors offer the button");
  assert.equal(bigLayout(model("full"), 2, {}).canShowGgp, false);
  assert.equal(bigLayout(model("full"), 2, { ggp: true }).canShowGgp, true);
  const on = bigLayout(m, 2, { ggp: true });
  const gg = on.nodes.filter((n) => n.g === -3);
  assert.deepEqual(gg.map((n) => [n.card.name, n.card.word, n.showBoth]), [["Gideon Eastlake", "great-grandfather", true], ["Ottoline Juniper", "great-grandmother", true]]);
  const gold = on.strips.filter((s) => s.rep);
  assert.ok(gold.length >= 4, "a bracket and a comb to both children");
  assert.equal(off.strips.filter((s) => s.rep).length, 0);
  assert.ok(on.rings.length > off.rings.length);
  assert.ok(on.labels.some((l) => l.text === "great-grandparents"));
  assert.equal(off.labels.some((l) => l.text === "great-grandparents"), false);
  // The pair sits above the middle of its two children.
  const kids = on.nodes.filter((n) => n.g === -2 && n.card.both);
  assert.ok(Math.abs((gg[0].cx + gg[1].cx) / 2 - (kids[0].cx + kids[1].cx) / 2) < EPS);
});

test("great-grandparents of unrelated grandparents are pushed apart so no two cards overlap", () => {
  const g = indexGraph({
    schemaVersion: 1,
    people: [["f", "m"], ["m", "f"], ["x", "u"], ["gp1", "m"], ["gp2", "f"], ["gp3", "m"], ["gp4", "f"], ["g1", "m"], ["g2", "f"], ["g3", "m"], ["g4", "f"], ["g5", "m"], ["g6", "f"], ["g7", "m"], ["g8", "f"]].map(([id, sex]) => ({ id, name: `${id} Sample`, given: id, surname: "Sample", sex })),
    unions: [
      { id: "uf", type: "married", partners: ["f", "m"], children: [{ id: "x", rel: {} }] },
      { id: "ua", type: "married", partners: ["gp1", "gp2"], children: [{ id: "f", rel: {} }] },
      { id: "ub", type: "married", partners: ["gp3", "gp4"], children: [{ id: "m", rel: {} }] },
      { id: "u1", type: "married", partners: ["g1", "g2"], children: [{ id: "gp1", rel: {} }] },
      { id: "u2", type: "married", partners: ["g3", "g4"], children: [{ id: "gp2", rel: {} }] },
      { id: "u3", type: "married", partners: ["g5", "g6"], children: [{ id: "gp3", rel: {} }] },
      { id: "u4", type: "married", partners: ["g7", "g8"], children: [{ id: "gp4", rel: {} }] }
    ]
  });
  const m = familyModel(g, "x");
  assert.deepEqual(m.both, { ids: [], shared: [], note: null });
  for (let lv = 0; lv <= 3; lv += 1) {
    const L = bigLayout(m, lv, { ggp: true });
    assert.equal(L.nodes.filter((n) => n.g === -3).length, 8);
    assertBigGeometry(L, `eight great-grandparents at ${lv}`);
  }
});

test("a parent with no recorded parents: a dashed ghost one row up and a dashed line to the parent; no parents: a dashed card and a dashed stub", () => {
  const m = model("siblings");
  const L = bigLayout(m, 2, {});
  const ghost = L.nodes.find((n) => n.kind === "ghost");
  assert.deepEqual([ghost.g, ghost.text, ghost.label, ghost.tell], [-2, "her parents not known yet.", "her parents not known yet.", true]);
  assert.equal(bigLayout(m, 0, {}).nodes.find((n) => n.kind === "ghost").label, "?");
  assert.equal(bigLayout(m, 0, {}).nodes.find((n) => n.kind === "ghost").tell, false);
  assert.ok(L.strips.some((s) => s.dashed));
  const none = bigLayout(model("noParents"), 1, {});
  assert.deepEqual(none.nodes.filter((n) => n.kind === "ghost").map((n) => [n.g, n.text]), [[-1, "parents not known yet."]]);
  assert.ok(none.strips.some((s) => s.dashed && s.h > 0 && s.w === LINE), "a dashed stub from the ghost to the person");
  const one = bigLayout(model("oneParent"), 1, {});
  assert.deepEqual(one.nodes.filter((n) => n.kind === "ghost").map((n) => n.text), ["father not known yet."]);
  assert.ok(one.strips.some((s) => s.dashed), "a dashed bracket to the missing parent");
});

test("see all: faces only, and whether it fits; scroll target puts the person in the middle and stays inside the canvas", () => {
  const m = model("full");
  const all = seeAll(m, {}, { width: 375, height: 600 });
  assert.equal(all.level, 0);
  assert.equal(all.layout.level, 0);
  assert.equal(all.fits, all.overflowX === 0 && all.overflowY === 0);
  assert.ok(all.layout.width <= 375, "a full family at 48 px fits a phone");
  const big = seeAll(model("large"), {}, { width: 375, height: 600 });
  assert.equal(big.fits, false);
  assert.equal(big.overflowX, Math.ceil(big.layout.width - 375));
  assert.equal(big.overflowX > 0, true);
  const L = bigLayout(m, 2, {});
  const t = scrollTarget(L, { width: 375, height: 700 });
  assert.equal(t.left, Math.min(Math.max(0, L.centre.x - 187.5), L.width - 375));
  assert.ok(t.top >= 0 && t.top <= Math.max(0, L.height - 700));
  assert.deepEqual(scrollTarget(L, { width: 5000, height: 5000 }), { left: 0, top: 0 }, "a canvas smaller than the viewport does not scroll");
  const mid = scrollTarget(L, { width: 100, height: 100 });
  assert.ok(Math.abs(mid.left + 50 - L.centre.x) < EPS && Math.abs(mid.top + 50 - L.centre.y) < EPS);
});

test("every viewport of the boards: the default size lays out, scrolls to the person, and the page never needs a sideways scroll of its own", () => {
  for (const [vw] of Object.entries(WIDTHS)) {
    for (const [name, id] of Object.entries(CASES)) {
      const m = familyModel(idx, id);
      const L = bigLayout(m, defaultLevel(Number(vw)), {});
      const viewport = { width: Number(vw), height: 800 };
      const t = scrollTarget(L, viewport);
      assert.ok(t.left >= 0 && t.left + viewport.width <= Math.max(L.width, viewport.width) + EPS, `${name} at ${vw}`);
      assert.ok(Number.isFinite(L.width) && Number.isFinite(L.height) && L.width > 0 && L.height > 0);
      assert.ok(L.nodes.every((n) => n.width >= 48 && n.height >= 48), "never smaller than the 48 px minimum, never scaled");
    }
  }
});

test("the big tree has the model's copy for chips and ghosts, and row labels come from COPY", () => {
  const L = bigLayout(model("pedigree"), 2, { ggp: true });
  assert.deepEqual(L.labels.map((l) => l.text), [COPY.rows[-3], COPY.rows[-2], COPY.rows[-1]]);
});

// Review fixes (pass 1, round 2): unique connectors, the closed chip's line, offsets that fit the gap, see all and the scroll target, the ggp rule.

/** The people of a person with `n` partners, each with one child: ids p (focus), w0.., k0.. (invented). */
function crowd(n) {
  const people = [{ id: "p", sex: "f" }, ...Array.from({ length: n }, (_, i) => [{ id: `w${i}`, sex: "m" }, { id: `k${i}`, sex: "u" }]).flat()];
  return indexGraph({
    schemaVersion: 1,
    people: people.map(({ id, sex }) => ({ id, name: `${id} Sample`, given: id, surname: "Sample", sex })),
    unions: Array.from({ length: n }, (_, i) => ({ id: `u${i}`, type: "married", partners: ["p", `w${i}`], children: [{ id: `k${i}`, rel: {} }] }))
  });
}

/** Every strip lies between two consecutive rows of cards (or a card's own bottom edge and the next row's top), give or take the 2 px line. */
function assertStripsBetweenRows(L, label) {
  const tops = new Map();
  const bottoms = new Map();
  for (const n of L.nodes) { tops.set(n.g, n.top); bottoms.set(n.g, n.top + n.height); }
  const gaps = [...bottoms.keys()].filter((g) => tops.has(g + 1)).map((g) => [bottoms.get(g), tops.get(g + 1)]);
  for (const s of L.strips) {
    assert.ok(s.w >= 0 && s.h >= 0, `${label}: a strip has a negative size: ${stripKey(s)}`);
    assert.ok(gaps.some(([a, b]) => s.y >= a - 1 - EPS && s.y + s.h <= b + 1 + EPS), `${label}: a strip leaves the gap between its two rows: ${stripKey(s)}`);
  }
  for (const r of L.rings) assert.ok(gaps.some(([a, b]) => r.cy > a && r.cy < b), `${label}: a ring is outside the gaps`);
}

test("no connector is drawn twice: strips and rings are unique in every case at every size, opened or not", () => {
  const dup = (list, key) => list.length - new Set(list.map(key)).size;
  for (const [name, id] of Object.entries(CASES)) {
    const m = familyModel(idx, id);
    for (let lv = 0; lv <= 3; lv += 1) for (const sibsOpen of [false, true]) for (const ggp of [false, true]) {
      const L = bigLayout(m, lv, { sibsOpen, ggp });
      assert.equal(dup(L.strips, stripKey), 0, `${name} level ${lv} sibs ${sibsOpen} ggp ${ggp}: duplicate strips`);
      assert.equal(dup(L.rings, (r) => `${r.cx},${r.cy}`), 0, `${name} level ${lv} sibs ${sibsOpen} ggp ${ggp}: duplicate rings`);
    }
  }
});

test("half brothers and sisters of one other union share one bracket and one comb: a second one adds a drop, not a bracket", () => {
  const withHalves = (n) => {
    const kids = Array.from({ length: n }, (_, i) => `h${i}`);
    return familyModel(indexGraph({
      schemaVersion: 1,
      people: ["x", "f", "m", "o", ...kids].map((id) => ({ id, name: `${id} Sample`, given: id, surname: "Sample", sex: id === "m" || id === "o" ? "f" : id === "f" ? "m" : "u" })),
      unions: [
        { id: "u0", type: "married", partners: ["f", "m"], children: [{ id: "x", rel: {} }] },
        { id: "u1", type: "married", partners: ["f", "o"], children: kids.map((id) => ({ id, rel: {} })) }
      ]
    }), "x");
  };
  const one = bigLayout(withHalves(2), 2, { sibsOpen: true });
  const open = bigLayout(withHalves(3), 2, { sibsOpen: true });
  assert.equal(open.rings.length, one.rings.length, "the parents' bracket and one for the father's other partner, however many half brothers there are");
  assert.equal(open.rings.length, 2);
  assert.equal(open.strips.length - one.strips.length, 1, "each extra half brother adds one drop");
  assert.equal(new Set(open.strips.map(stripKey)).size, open.strips.length);
  for (let lv = 0; lv <= 3; lv += 1) assertBigGeometry(bigLayout(withHalves(3), lv, { sibsOpen: true }), `three half brothers at ${lv}`);
});

test("the closed brothers-and-sisters chip hangs like what it holds: solid with a full brother or sister, dashed when all are half", () => {
  const drop = (L, chip) => L.strips.filter((s) => s.w === LINE && s.x === chip.cx - 1 && s.y + s.h === chip.top);
  for (const lv of [0, 1, 2, 3]) {
    const full = bigLayout(model("full"), lv, {});
    const fc = full.nodes.find((n) => n.kind === "chip");
    assert.ok(drop(full, fc).length === 1 && drop(full, fc).every((s) => !s.dashed), `full siblings, level ${lv}: a solid drop`);
    const mixed = bigLayout(model("siblings"), lv, {});
    const mc = mixed.nodes.find((n) => n.kind === "chip");
    assert.ok(drop(mixed, mc).length === 1 && drop(mixed, mc).every((s) => !s.dashed), `full and half, level ${lv}: solid, the chip holds a full one`);
    const half = model("partners");
    assert.ok(half.siblings.list.length && half.siblings.list.every((x) => x.half), "the partners case has only half brothers and sisters");
    const hl = bigLayout(half, lv, {});
    const hc = hl.nodes.find((n) => n.kind === "chip");
    assert.ok(drop(hl, hc).length === 1 && drop(hl, hc).every((s) => s.dashed), `half only, level ${lv}: a dashed drop`);
    assert.equal(hl.strips.filter((s) => !s.dashed && s.x <= hc.cx && s.x + s.w >= hc.cx && s.y + s.h <= hc.top).length, 0, "no solid strip over the chip");
  }
});

test("a person with ten partners and ten children blocks: every strip stays between its two rows at every size", () => {
  for (const n of [4, 8, 10]) {
    const m = familyModel(crowd(n), "p");
    assert.equal(m.partners.length, n);
    assert.equal(m.blocks.filter((b) => b.kids.length).length, n);
    for (let lv = 0; lv <= 3; lv += 1) {
      const L = bigLayout(m, lv, {});
      assertBigGeometry(L, `${n} partners at ${lv}`);
      assertStripsBetweenRows(L, `${n} partners at level ${lv}`);
      assert.equal(new Set(L.strips.map(stripKey)).size, L.strips.length, `${n} partners at ${lv}: unique strips`);
    }
  }
  const four = bigLayout(familyModel(crowd(4), "p"), 2, {});
  const ys = four.rings.map((r) => r.cy).sort((a, b) => a - b);
  assert.deepEqual(ys.map((y) => y - ys[0]), [0, 7, 14, 21], "a few partners keep the 7 px step");
});

test("every fixture case, every size: strips stay between their two rows", () => {
  for (const [name, id] of Object.entries(CASES)) {
    const m = familyModel(idx, id);
    for (let lv = 0; lv <= 3; lv += 1) for (const sibsOpen of [false, true]) assertStripsBetweenRows(bigLayout(m, lv, { sibsOpen, ggp: true }), `${name} level ${lv}`);
  }
});

test("see all: it fits exactly when neither side is wider than the viewport, and says by how much it does not", () => {
  const m = model("full");
  const L = seeAll(m, {}, { width: 9999, height: 9999 }).layout;
  const w = Math.ceil(L.width);
  const h = Math.ceil(L.height);
  assert.deepEqual(seeAll(m, {}, { width: w, height: h }), { level: 0, layout: L, fits: true, overflowX: 0, overflowY: 0 });
  const narrow = seeAll(m, {}, { width: w - 1, height: h });
  assert.deepEqual([narrow.fits, narrow.overflowX, narrow.overflowY], [false, 1, 0]);
  const short = seeAll(m, {}, { width: w, height: h - 5 });
  assert.deepEqual([short.fits, short.overflowX, short.overflowY], [false, 0, 5]);
  const opened = seeAll(model("siblings"), { sibsOpen: true }, { width: 9999, height: 9999 }).layout;
  assert.ok(opened.width > seeAll(model("siblings"), {}, { width: 9999, height: 9999 }).layout.width, "the options pass through: opened brothers and sisters are wider");
  assert.equal(seeAll(m, {}, { width: 320, height: 568 }).layout.level, 0);
});

test("scroll target: the person is centred, and the offsets clamp to the canvas at every edge", () => {
  const canvas = (x, y) => ({ centre: { x, y }, width: 1000, height: 600 });
  const vp = { width: 200, height: 100 };
  assert.deepEqual(scrollTarget(canvas(500, 300), vp), { left: 400, top: 250 }, "centred");
  assert.deepEqual(scrollTarget(canvas(20, 10), vp), { left: 0, top: 0 }, "person near the top left: clamped to 0");
  assert.deepEqual(scrollTarget(canvas(990, 595), vp), { left: 800, top: 500 }, "person near the bottom right: clamped to canvas minus viewport");
  assert.deepEqual(scrollTarget(canvas(500, 300), { width: 1000, height: 600 }), { left: 0, top: 0 }, "a canvas exactly the viewport");
  for (const [name, id] of Object.entries(CASES)) {
    const L = bigLayout(familyModel(idx, id), 2, {});
    const t = scrollTarget(L, vp);
    assert.ok(t.left >= 0 && t.left <= Math.max(0, L.width - vp.width) && t.top >= 0 && t.top <= Math.max(0, L.height - vp.height), `${name}: inside the canvas`);
    if (t.left > 0 && t.left < L.width - vp.width) assert.ok(Math.abs(t.left + vp.width / 2 - L.centre.x) < EPS, `${name}: centred sideways when it can be`);
  }
});

test("canShowGgp: offered when the great-grandparents are shared (brother and sister grandparents, or one grandparent under both parents) and recorded", () => {
  assert.equal(bigLayout(model("pedigree"), 2, {}).canShowGgp, true);
  // One grandparent (gx) under both parents, and that grandparent's own parents recorded: the rule is the shared great-grandparents, not both.shared.
  const g = indexGraph({
    schemaVersion: 1,
    people: [["x", "u"], ["f", "m"], ["m", "f"], ["gx", "m"], ["ga", "f"], ["gb", "f"], ["z1", "m"], ["z2", "f"]].map(([id, sex]) => ({ id, name: `${id} Sample`, given: id, surname: "Sample", sex })),
    unions: [
      { id: "u0", type: "married", partners: ["f", "m"], children: [{ id: "x", rel: {} }] },
      { id: "ua", type: "married", partners: ["gx", "ga"], children: [{ id: "f", rel: {} }] },
      { id: "ub", type: "married", partners: ["gx", "gb"], children: [{ id: "m", rel: {} }] },
      { id: "uz", type: "married", partners: ["z1", "z2"], children: [{ id: "gx", rel: {} }] }
    ]
  });
  const both = familyModel(g, "x");
  assert.equal(both.both.shared.length, 0, "no brother and sister pair among the grandparents");
  assert.equal(both.both.note, null);
  assert.deepEqual(both.ggp.map((z) => z.shared), [true], "but the grandparent's own parents are on both sides");
  assert.equal(bigLayout(both, 2, {}).canShowGgp, true);
  const on = bigLayout(both, 2, { ggp: true });
  assert.equal(on.nodes.filter((n) => n.g === -3).length, 2);
  assertBigGeometry(on, "one grandparent under both parents, great-grandparents on");
  // Under both parents with no recorded parents of their own, there is nothing to offer; so for unshared families.
  assert.equal(bigLayout(model("bothSides"), 2, {}).canShowGgp, false);
  for (const c of ["full", "oneParent", "noParents", "large", "alone"]) assert.equal(bigLayout(model(c), 2, {}).canShowGgp, false, c);
});
