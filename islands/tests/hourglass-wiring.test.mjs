// HFY-TSK-379 pass 2: the small seams of the person-page wiring that run in plain node: the remembered view survives a storage that throws, the big tree's
// address only takes ids the tree page takes, and the graph is fetched once for the card mini view and the hourglass together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VIEW_KEY, readView } from "../src/lib/hourglass-ui.js";
import { bigHref } from "../src/lib/hourglass-links.js";
import { cachedGraph } from "../src/lib/tree-data.js";
import { hourglassLinks, treeLinkHref } from "../src/lib/tree-link.js";
import { GRAPH } from "./fixtures/hourglass-cases.mjs";

const lib = (f) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", f), "utf8");
const withStorage = (store, fn) => {
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: store });
  try { return fn(); } finally { if (had) Object.defineProperty(globalThis, "localStorage", had); else delete globalThis.localStorage; }
};

test("the remembered view is cards only when cards were chosen; a storage that throws, or holds anything else, reads as the tree", () => {
  assert.equal(VIEW_KEY, "hfy:person-family-view");
  const mem = (v) => () => ({ getItem: (k) => (k === VIEW_KEY ? v : null) });
  assert.equal(withStorage(mem("cards"), readView), "cards");
  assert.equal(withStorage(mem("tree"), readView), "tree");
  assert.equal(withStorage(mem(null), readView), "tree");
  assert.equal(withStorage(mem("poster"), readView), "tree");
  assert.equal(withStorage(() => { throw new Error("blocked"); }, readView), "tree", "the getter itself throws in a private window");
  assert.equal(withStorage(() => ({ getItem() { throw new Error("denied"); } }), readView), "tree");
});

test("bigHref names the big tree for the person and the page they came from, and takes only the ids the tree page takes", () => {
  assert.equal(bigHref("I9007", "I9007"), "/tree/?view=tree&focus=I9007&from=I9007");
  assert.equal(bigHref("I9007", "I9020"), "/tree/?view=tree&focus=I9007&from=I9020");
  assert.equal(bigHref("I9007", "bad id!"), "/tree/?view=tree&focus=I9007", "a from that does not match is left out");
  for (const bad of ["", "a b", "../x", "x".repeat(33), "I1&focus=I2", null, undefined, 7]) assert.equal(bigHref(bad, "I9007"), null, String(bad));
  // the same pattern as the tree page's own link (lib/tree-link.js): both accept and refuse the same ids
  for (const id of ["I9007", "a_b-c", "x".repeat(32), "x".repeat(33), "a b", "a/b", "é", ""]) assert.equal(bigHref(id, id) !== null, treeLinkHref(id) !== null, JSON.stringify(id));
  assert.match(lib("hourglass-links.js"), /const ID = \/\^\[A-Za-z0-9_-\]\{1,32\}\$\/;/);
  assert.match(lib("tree-link.js"), /\/\^\[A-Za-z0-9_-\]\{1,32\}\$\/\.test\(id\)/);
});

test("cachedGraph asks once while the graph is ready, and again after a failure; a rejection is not kept", async () => {
  let calls = 0;
  const ok = async () => { calls += 1; return { ok: true, status: 200, text: async () => JSON.stringify(GRAPH) }; };
  const cache = {};
  const [a, b] = await Promise.all([cachedGraph(cache, ok), cachedGraph(cache, ok)]);
  assert.equal(a.state, "ready");
  assert.equal(a, b, "one result for both askers");
  assert.equal(calls, 1);
  await cachedGraph(cache, ok);
  assert.equal(calls, 1, "kept while ready");
  const gated = {};
  let n = 0;
  const never = async () => { n += 1; return { ok: false, status: 401 }; };
  assert.equal((await cachedGraph(gated, never)).state, "signin");
  assert.equal((await cachedGraph(gated, never)).state, "signin");
  assert.equal(n, 2, "a graph that did not load is asked for again");
  const boom = {};
  assert.equal((await cachedGraph(boom, async () => { throw new Error("offline"); })).state, "error");
  assert.equal(boom.promise, null);
});

test("the footer links exist only for views the visitor has: outline with familyViz, table with familyViz and familyVizTime", () => {
  const f = (o) => hourglassLinks(o);
  assert.deepEqual(f({ familyViz: true }), { outline: true, table: false });
  assert.deepEqual(f({ familyViz: true, familyVizTime: false }), { outline: true, table: false });
  assert.deepEqual(f({ familyViz: true, familyVizTime: true }), { outline: true, table: true });
  assert.deepEqual(f({ familyViz: false, familyVizTime: true }), { outline: false, table: false }, "the time view needs familyViz too");
  assert.deepEqual(f({ familyVizTime: true }), { outline: false, table: false });
  assert.deepEqual(f({ familyViz: "true", familyVizTime: "true" }), { outline: false, table: false }, "only a real true counts");
  assert.deepEqual(f(null), { outline: false, table: false }, "flags that could not be read");
  assert.deepEqual(f(undefined), { outline: false, table: false });
  // the renderer draws the table link only from what this says, and the outline link always (the tree is only drawn with familyViz)
  assert.match(lib("tree-hourglass.js"), /links\.table && \[/);
  assert.match(lib("tree-link.js"), /tableOn = hourglassLinks\(flags\)\.table;/);
});

test("the hourglass has no toast of its own: the thank-you is a polite status line, and the person page waits for the island before holding the frame back for good", () => {
  assert.match(lib("tree-hourglass.js"), /role: "status"/);
  assert.match(lib("tree-hourglass.js"), /not a toast/);
  const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "11ty", "js", "person-page.js"), "utf8");
  assert.match(page, /ISLAND_WAIT_MS = 4000/);
  assert.match(page, /watchForIsland\(personId\);/);
});
