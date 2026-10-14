// HFY-TSK-190: the feed line copy grammar (lib/contrib-line.jsx). Synthetic numbers only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FALLBACK, lineCopy, lineFor } from "../src/lib/contrib-line.js";

const cases = [
  [{ x: 12, y: 3, unit: "day" }, "12 contributions in the past 3 days"],
  [{ x: 1, y: 3, unit: "day" }, "1 contribution in the past 3 days"],
  [{ x: 5, y: 1, unit: "week" }, "5 contributions in the past week"],
  [{ x: 1, y: 1, unit: "week" }, "1 contribution in the past week"],
  [{ x: 9, y: 2, unit: "month" }, "9 contributions in the past 2 months"],
  [{ x: 4, y: 1, unit: "month" }, "4 contributions in the past month"],
  [{ x: 7, y: 1, unit: "year" }, "7 contributions in the past year"],
  [{ x: 30, y: 2, unit: "year" }, "30 contributions in the past 2 years"],
  [{ x: 3, y: 1, unit: "day" }, "3 contributions in the past day"],
];
for (const [line, want] of cases) test(`lineCopy ${JSON.stringify(line)}`, () => assert.equal(lineCopy(line), want));

test("a null line is the fallback copy, lowercase, no number", () => {
  assert.equal(lineFor({ total: 0, line: null }), FALLBACK);
  assert.equal(FALLBACK, "add a photo or a story to get things going.");
  assert.doesNotMatch(FALLBACK, /\d|[A-Z]|!/);
});

test("a line is spelled from x, y and unit, whatever text the server sent", () => {
  assert.equal(lineFor({ line: { x: 1, y: 1, unit: "week", text: "1 contributions in the past 1 weeks" } }), "1 contribution in the past week");
});

test("unusable bodies draw nothing", () => {
  for (const b of [undefined, null, 5, {}, { line: "x" }, { line: { x: 2, y: 0, unit: "day" } }, { line: { x: -1, y: 2, unit: "day" } }, { line: { x: 2, y: 2, unit: "decade" } }, { line: { x: 1.5, y: 2, unit: "day" } }]) assert.equal(lineFor(b), null, JSON.stringify(b));
});
