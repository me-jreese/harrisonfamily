// HFY-TSK-269 (viz-v2-time) AC2 and AC3: the lifelines model (lib/lifelines-model.js) in node, on synthetic graphs only. Union years, the fades,
// the dot, the living line, the 40-line cap with its "+N more" rows, and decades only (no era band in the model's output).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_LINES, axisOf, buildLifelines, fadeWidth, markOf, unionYear, xOf } from "../src/lib/lifelines-model.js";
import { parseGraph } from "../src/lib/family-graph.js";
import { synthGraph } from "./fixtures/graph-synth.mjs";

const fixture = () => parseGraph(readFileSync(new URL("./fixtures/lifelines-graph.json", import.meta.url), "utf8"));
const TODAY = 2026;
const row = (m, id) => m.rows.find((r) => r.id === id);
const idx = (m, id) => m.rows.findIndex((r) => r.id === id);

test("markOf: a line, a dot for one known year, a living line to today, an approximate year fades, nothing known is none", () => {
  assert.deepEqual(markOf({ birthYear: 1880, deathYear: 1950, living: false, yearApprox: false }, TODAY), { kind: "line", start: 1880, end: 1950, ongoing: false, fuzzy: false });
  assert.equal(markOf({ birthYear: 1880, deathYear: 1950, living: false, yearApprox: true }, TODAY).fuzzy, true);
  assert.deepEqual(markOf({ birthYear: 1932, deathYear: null, living: false }, TODAY), { kind: "dot", start: 1932, end: 1932, ongoing: false, fuzzy: false });
  assert.deepEqual(markOf({ birthYear: null, deathYear: 1990, living: false }, TODAY), { kind: "dot", start: 1990, end: 1990, ongoing: false, fuzzy: false });
  assert.deepEqual(markOf({ birthYear: 1990, deathYear: null, living: true }, TODAY), { kind: "line", start: 1990, end: TODAY, ongoing: true, fuzzy: false });
  // a living person's death year is never read
  assert.equal(markOf({ birthYear: 1990, deathYear: 2001, living: true }, TODAY).end, TODAY);
  assert.equal(markOf({ birthYear: null, deathYear: null, living: true }, TODAY).kind, "none");
  assert.equal(markOf({ birthYear: null, deathYear: null, living: false }, TODAY).kind, "none");
  // a death year that is not after the birth year is a dot, never a backwards line
  assert.equal(markOf({ birthYear: 1900, deathYear: 1899, living: false }, TODAY).kind, "dot");
});

test("a person in two unions: each union converges at its own first child; an undated union draws no convergence", () => {
  const g = fixture();
  const m = buildLifelines(g, "I8010", { today: TODAY });
  const byKey = Object.fromEntries(m.unions.map((u) => [u.key, u]));
  assert.equal(byKey.F8010.year, 1932);
  assert.equal(byKey.F8011.year, 1950);
  assert.equal(byKey.F8012, undefined, "no dated child: partners do not converge");
  // the parents' union converges at the first child's birth year too (the focus person or a sibling)
  assert.equal(byKey.F8001.year, 1908);
  // each union connects the focus row to its partner row and its children
  const focus = idx(m, "I8010");
  assert.ok(byKey.F8010.nodes.includes(focus) && byKey.F8010.nodes.includes(idx(m, "I8020")));
  assert.deepEqual(byKey.F8010.kids.map((k) => m.rows[k].id), ["I8030", "I8031"]);
  assert.ok(byKey.F8011.nodes.includes(idx(m, "I8021")));
  // the marriage-year rule is not used: unionYear reads children only
  assert.equal(unionYear(g, { children: [{ id: "I8032" }, { id: "I8031" }] }), 1935);
  assert.equal(unionYear(g, { children: [{ id: "I8033" }] }), null);
  assert.equal(unionYear(g, { children: [] }), null);
});

test("rows: parents first, the focus, then each union's partner and children; marks follow the data", () => {
  const m = buildLifelines(fixture(), "I8010", { today: TODAY });
  assert.deepEqual(m.rows.map((r) => r.id), ["I8001", "I8002", "I8010", "I8020", "I8030", "I8031", "I8021", "I8032", "I8022", "I8033"]);
  assert.equal(row(m, "I8001").depth, 0);
  assert.equal(row(m, "I8010").depth, 1);
  assert.equal(row(m, "I8030").depth, 2);
  assert.equal(row(m, "I8030").mark.kind, "dot");
  assert.equal(row(m, "I8031").mark.ongoing, true);
  assert.equal(row(m, "I8020").mark.fuzzy, true);
  assert.equal(row(m, "I8033").mark.kind, "none");
  assert.equal(m.lineCount, 10);
});

test("the axis is whole decades and the one linear scale maps them inside the lane", () => {
  const m = buildLifelines(fixture(), "I8010", { today: TODAY });
  assert.equal(m.axis.min, 1880);
  assert.equal(m.axis.max, 2030);
  assert.ok(m.axis.ticks.every((t) => t.year % 10 === 0));
  assert.equal(m.axis.ticks.length, (m.axis.max - m.axis.min) / 10 + 1);
  assert.ok(m.axis.ticks.filter((t) => t.label).length <= 12);
  assert.ok(xOf(m.axis, m.axis.min) > 0 && xOf(m.axis, m.axis.max) < 100);
  assert.ok(xOf(m.axis, 1950) > xOf(m.axis, 1900));
  assert.equal(axisOf([], [], TODAY), null);
  // a fade never exceeds a decade or a third of the line
  const f = fadeWidth(m.axis, { start: 1912, end: 1980 });
  assert.ok(f > 0 && f <= xOf(m.axis, 1990) - xOf(m.axis, 1980) + 1e-9);
});

test("decades only: nothing in the model is an era band", () => {
  const m = buildLifelines(fixture(), "I8010", { today: TODAY });
  const text = JSON.stringify({ ...m, rows: m.rows.map(({ person, ...r }) => r) });
  assert.doesNotMatch(text, /\bera\b|band|chapter/i);
  assert.deepEqual(Object.keys(m).sort(), ["axis", "focus", "lineCount", "rows", "unions"]);
});

test("at most 40 lines for a 2,000-person graph, and what does not fit collapses into '+N more' rows", () => {
  const g = parseGraph(JSON.stringify(synthGraph(2000)));
  const focus = g.defaultFocus();
  assert.ok(g.descendantCount(focus) > 40, "the synthetic founder has more than 40 descendants");
  const m = buildLifelines(g, focus, { today: TODAY });
  assert.equal(MAX_LINES, 40);
  assert.ok(m.lineCount <= 40 && m.lineCount === m.rows.filter((r) => r.type === "line").length);
  assert.ok(m.lineCount >= 30, "the budget is used");
  const more = m.rows.filter((r) => r.type === "more");
  assert.ok(more.length >= 1);
  for (const r of more) assert.ok(r.count >= 1 && g.has(r.id) && m.rows.some((x) => x.type === "line" && x.id === r.id));
  // a smaller cap shows fewer lines and still never drops a family silently
  const small = buildLifelines(g, focus, { maxLines: 5, today: TODAY });
  assert.ok(small.lineCount <= 5);
  assert.ok(small.rows.some((r) => r.type === "more"));
});

test("the shown lines plus every '+N more' are exactly the people reachable from the focus", () => {
  const g = parseGraph(JSON.stringify(synthGraph(2000)));
  const focus = g.defaultFocus();
  const reach = new Set([...g.parents(focus).slice(0, 2).map((p) => p.id), focus]);
  const stack = [focus];
  while (stack.length) {
    const id = stack.pop();
    for (const u of g.unionsOf(id)) for (const x of [u.partner, ...u.children.map((c) => c.id)]) if (x && !reach.has(x)) { reach.add(x); stack.push(x); }
  }
  for (const maxLines of [40, 12, 5]) {
    const m = buildLifelines(g, focus, { maxLines, today: TODAY });
    const more = m.rows.filter((r) => r.type === "more").reduce((n, r) => n + r.count, 0);
    assert.equal(m.lineCount + more, reach.size, `maxLines ${maxLines}`);
  }
});

test("a focus not in the graph is empty; every person appears once", () => {
  const g = fixture();
  assert.deepEqual(buildLifelines(g, "I0", { today: TODAY }).rows, []);
  const m = buildLifelines(g, "I8001", { today: TODAY });
  const ids = m.rows.filter((r) => r.type === "line").map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});
