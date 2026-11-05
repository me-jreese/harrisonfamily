// HFY-TSK-271 (viz-v2-faces): picturedWith (lib/navigator-model.js) in node, on the synthetic tests/fixtures/tree-graph-small.json (invented
// names) with a synthetic photoEdges block. The chips read only the published graph's photoEdges: the builder leaves a private Media, a private
// MediaRef, a private person and a RECT_INVALID tag out of the block (graph/README.md "Photo co-occurrence"), so a fixture of that output has no
// entry for them, and the model shows no chip for that person. That exclusion is the builder contract (viz-graph-v2-data); the client cannot see a
// private entry, so these tests pin the published shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseGraph } from "../src/lib/family-graph.js";
import { picturedWith } from "../src/lib/navigator-model.js";

const base = JSON.parse(readFileSync(new URL("./fixtures/tree-graph-small.json", import.meta.url), "utf8"));
const withEdges = (photoEdges) => parseGraph({ ...base, photoEdges });

test("one chip per person sharing a photo with the focus, most shared first, then by name", () => {
  const g = withEdges([
    { media: "O1", people: ["I9003", "I9004", "I9002"] },
    { media: "O2", people: ["I9003", "I9004"] },
    { media: "O3", people: ["I9001", "I9002"] }
  ]);
  assert.deepEqual(picturedWith(g, "I9003"), [
    { id: "I9004", name: "Bram Example", photos: 2 },
    { id: "I9002", name: "Hana Sample", photos: 1 }
  ]);
  assert.deepEqual(picturedWith(g, "I9001").map((c) => c.id), ["I9002"]);
});

test("a person with no shared photo, or alone in one, has no chip", () => {
  const g = withEdges([{ media: "O1", people: ["I9003"] }, { media: "O2", people: ["I9004", "I9002"] }]);
  assert.deepEqual(picturedWith(g, "I9003"), []);
  assert.deepEqual(picturedWith(g, "I9011"), []);
});

test("a person the published graph does not hold (a private MediaRef or RECT_INVALID tag never reaches photoEdges) shows no chip", () => {
  const g = withEdges([{ media: "O1", people: ["I9003", "I9999", "I9004"] }]);
  assert.deepEqual(picturedWith(g, "I9003").map((c) => c.id), ["I9004"]);
  assert.deepEqual(picturedWith(g, "I9999"), []);
});

test("a graph without photoEdges, or with a malformed block, gives no chips and no error", () => {
  assert.deepEqual(picturedWith(parseGraph(base), "I9003"), []);
  for (const bad of [null, "x", {}, [null, 3, "s", { media: 1, people: ["I9003", "I9004"] }, { media: "O1" }, { media: "O2", people: "I9004" }]]) {
    assert.deepEqual(picturedWith(parseGraph({ ...base, photoEdges: bad }), "I9003"), []);
  }
});

test("a repeated media or a repeated person counts once", () => {
  const g = withEdges([
    { media: "O1", people: ["I9003", "I9004", "I9004"] },
    { media: "O1", people: ["I9003", "I9004"] }
  ]);
  assert.deepEqual(picturedWith(g, "I9003"), [{ id: "I9004", name: "Bram Example", photos: 1 }]);
});
