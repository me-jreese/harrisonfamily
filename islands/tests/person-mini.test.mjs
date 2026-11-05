// HFY-TSK-289: the mini focus view's pure model and DOM (synthetic data only).
import test from "node:test";
import assert from "node:assert/strict";
import { parseGraph } from "../src/lib/family-graph.js";
import { MINI_MAX, miniModel } from "../src/lib/person-mini.js";

const graph = parseGraph({
  schemaVersion: 1,
  people: [
    { id: "I1", name: "Focus Example", birthYear: 1950 }, { id: "I2", name: "Parent Example", birthYear: 1925 },
    { id: "I3", name: "Partner Example", birthYear: 1952 }, ...Array.from({ length: 8 }, (_, i) => ({ id: `I1${i}`, name: `Child ${i}`, birthYear: 1975 + i }))
  ],
  unions: [
    { id: "F1", partners: ["I2"], children: [{ id: "I1", rel: {} }] },
    { id: "F2", partners: ["I1", "I3"], children: Array.from({ length: 8 }, (_, i) => ({ id: `I1${i}`, rel: {} })) }
  ]
});

test("miniModel groups parents, partners and children, caps each group and counts the rest", () => {
  const m = miniModel(graph, "I1");
  assert.equal(m.focus.name, "Focus Example");
  assert.deepEqual(m.groups.map((g) => g.key), ["parents", "partners", "children"]);
  const kids = m.groups[2];
  assert.equal(kids.shown.length, MINI_MAX);
  assert.equal(kids.more, 2);
});

test("miniModel drops empty groups and returns null for an unknown person", () => {
  assert.deepEqual(miniModel(graph, "I3").groups.map((g) => g.key), ["partners", "children"]);
  assert.equal(miniModel(graph, "I404"), null);
});

// ---- DOM level (HFY-TSK-289 review): a tiny fake document, enough for renderMini and fillMini.
import { fillMini, renderMini } from "../src/lib/person-mini.js";

class El {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.kids = []; this.parent = null; this.text = ""; this.className = ""; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  append(...n) { for (const x of n) { x.parent = this; this.kids.push(x); } }
  appendChild(n) { this.append(n); }
  insertBefore(n, ref) { n.parent = this; const i = ref ? this.kids.indexOf(ref) : this.kids.length; this.kids.splice(i < 0 ? 0 : i, 0, n); }
  get firstChild() { return this.kids[0] ?? null; }
  set textContent(t) { this.text = t; }
  get textContent() { return this.text + this.kids.map((k) => k.textContent).join(""); }
  remove() { if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this); this.parent = null; }
  all() { return this.kids.flatMap((k) => [k, ...k.all()]); }
  querySelector(sel) { const m = /^\[([\w-]+)\]$/.exec(sel); return this.all().find((k) => m && m[1] in k.attrs) ?? null; }
}
const fakeDoc = { createElement: (t) => new El(t), createTextNode: (t) => Object.assign(new El("#text"), { text: t }) };
const ok = (g) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(g) });
const jsonGraph = { schemaVersion: 1, people: [{ id: "I1", name: "Focus Example", birthYear: 1950, living: true }, { id: "I2", name: "Parent Example", birthYear: 1925, deathYear: 1990 }], unions: [{ id: "F1", partners: ["I2"], children: [{ id: "I1", rel: {} }] }], generations: [] };

test("renderMini: groups are labelled, titles are not headings, no aria-current; a living card shows no death year", () => {
  const model = miniModel(parseGraph(jsonGraph), "I1");
  const root = renderMini(fakeDoc, model, "/tree/?focus=I1");
  const all = root.all();
  assert.equal(all.some((e) => e.tag === "h3"), false);
  assert.equal(all.some((e) => "aria-current" in e.attrs), false);
  assert.deepEqual(all.filter((e) => e.attrs["data-mini-group"]).map((e) => e.attrs["data-mini-group"]), ["parents", "focus"]);
  assert.ok(all.filter((e) => e.attrs["data-mini-group"]).every((e) => e.attrs.role === "group" && e.attrs["aria-label"]));
  const years = all.filter((e) => e.className === "hfy-mini__years").map((e) => e.text);
  assert.deepEqual(years, ["1925 to 1990", "born 1950"]);
});

test("fillMini: draws the view; a missing graph (404), a failed fetch, bad JSON and an unknown person all return false and leave the host empty", async () => {
  const host = new El("div");
  assert.equal(await fillMini(fakeDoc, host, "I1", "/t", ok(jsonGraph), {}), true);
  assert.ok(host.querySelector("[data-person-mini]"));
  const cases = [
    [async () => ({ ok: false, status: 404, text: async () => "" }), "I1"],
    [async () => ({ ok: false, status: 500, text: async () => "" }), "I1"],
    [async () => { throw new Error("offline"); }, "I1"],
    [async () => ({ ok: true, status: 200, text: async () => "not json" }), "I1"],
    [ok(jsonGraph), "I404"]
  ];
  for (const [fetcher, id] of cases) {
    const h = new El("div");
    assert.equal(await fillMini(fakeDoc, h, id, "/t", fetcher, {}), false);
    assert.equal(h.querySelector("[data-person-mini]"), null);
  }
});

test("fillMini: a failed load is not cached, and a newer fill wins over a slower earlier one", async () => {
  const cache = {};
  assert.equal(await fillMini(fakeDoc, new El("div"), "I1", "/t", async () => ({ ok: false, status: 500, text: async () => "" }), cache), false);
  assert.equal(cache.promise, null);
  const host = new El("div");
  let release;
  const slow = new Promise((r) => { release = r; });
  const first = fillMini(fakeDoc, host, "I2", "/t", async () => { await slow; return ok(jsonGraph)(); }, {});
  const second = await fillMini(fakeDoc, host, "I1", "/t", ok(jsonGraph), {});
  release();
  assert.equal(second, true);
  assert.equal(await first, false);
  assert.equal(host.all().filter((e) => "data-person-mini" in e.attrs).length, 1);
  assert.match(host.textContent, /Focus Example/);
});
