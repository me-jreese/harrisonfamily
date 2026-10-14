// HFY-TSK-302 AC4: the contrast helper's maths, against values that are defined by WCAG 2.2 itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contrast, luminance, parseColor } from "./contrast.mjs";

test("black on white is 21:1 and a colour on itself is 1:1", () => {
  assert.equal(contrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), 21);
  assert.equal(contrast({ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }), 21);
  assert.equal(contrast({ r: 10, g: 20, b: 30 }, { r: 10, g: 20, b: 30 }), 1);
});

test("the luminance of the primaries follows the sRGB coefficients", () => {
  assert.ok(Math.abs(luminance({ r: 255, g: 0, b: 0 }) - 0.2126) < 1e-9);
  assert.ok(Math.abs(luminance({ r: 0, g: 255, b: 0 }) - 0.7152) < 1e-9);
  assert.ok(Math.abs(luminance({ r: 0, g: 0, b: 255 }) - 0.0722) < 1e-9);
});

test("#777 on white is the textbook 4.48:1 (just under AA text)", () => {
  assert.ok(Math.abs(contrast(parseColor("#777"), parseColor("#ffffff")) - 4.48) < 0.01);
});

test("colours parse from hex and from rgb()/rgba(), and alpha is composited over the background", () => {
  assert.deepEqual(parseColor("#0a141e"), { r: 10, g: 20, b: 30 });
  assert.deepEqual(parseColor("rgb(10, 20, 30)"), { r: 10, g: 20, b: 30 });
  assert.deepEqual(parseColor("rgb(10 20 30 / 50%)", { r: 0, g: 0, b: 0 }), { r: 5, g: 10, b: 15 });
  assert.deepEqual(parseColor("rgba(255, 255, 255, 0.5)", { r: 0, g: 0, b: 0 }), { r: 127.5, g: 127.5, b: 127.5 });
  assert.throws(() => parseColor("oklch(0.5 0.1 200)"), /cannot parse/);
});
