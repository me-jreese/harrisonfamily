// The pure side of CappedSection (HFY-TSK-188): the cap sizes and expression, which items are clipped, and the #comment-<ulid> hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CAP_SMALL, CAP_WIDE, MAX_STEPS, WIDE_QUERY, capExpression, commentFromHash, hiddenIndexes } from "../src/lib/capped-model.js";

test("the cap is 7 x space-9 below 43rem and 9 x from there, and one step adds one more cap", () => {
  assert.equal(CAP_SMALL, 7);
  assert.equal(CAP_WIDE, 9);
  assert.equal(WIDE_QUERY, "(min-width: 43rem)");
  assert.equal(capExpression(false), "calc(var(--io-space-9) * 7)");
  assert.equal(capExpression(true), "calc(var(--io-space-9) * 9)");
  assert.equal(capExpression(false, 1), "calc(var(--io-space-9) * 14)");
  assert.equal(capExpression(true, 2), "calc(var(--io-space-9) * 27)");
  assert.equal(capExpression(true, -3), "calc(var(--io-space-9) * 9)");
  assert.ok(MAX_STEPS >= 5);
});

test("an item that starts at or below the cap is clipped; one that starts above it is not, even if it ends below", () => {
  assert.deepEqual(hiddenIndexes([0, 100, 200, 300, 400, 448, 600], 448), [5, 6]);
  assert.deepEqual(hiddenIndexes([0, 447.4, 447.6], 448), [2]);
  assert.deepEqual(hiddenIndexes([0, 100], 448), []);
  assert.deepEqual(hiddenIndexes([], 448), []);
  assert.deepEqual(hiddenIndexes([0, 9999], NaN), [], "no cap measured (the list is not laid out), nothing is clipped");
});

test("only an #comment-<id> hash names a comment", () => {
  assert.equal(commentFromHash("#comment-01JZZZZZZZZZZZZZZZZZZZ0012"), "01JZZZZZZZZZZZZZZZZZZZ0012");
  for (const bad of ["", "#", "#share", "#comment-", "#comment-abc", "#comment-01J\"]x", "comment-01JZZZZZZZZZZZZZZZZZZZ0012", "#comment-01JZZZZZZZZZZZZZZZZZZZ0012 ", null, undefined]) assert.equal(commentFromHash(bad), null, String(bad));
});
