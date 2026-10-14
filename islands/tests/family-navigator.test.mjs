// HFY-TSK-145: the event contract between <family-navigator> and the island's ChartView, in node (no DOM): the lazy ChartView listens with
// bindNavigatorEvents, so dispatching hfy-focus and hfy-details on a plain EventTarget exercises exactly that code. The element's rendering
// is covered by the Playwright specs in tests/tree.spec.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_DETAILS, EVENT_FOCUS, FamilyNavigator, TAG, bindNavigatorEvents, defineFamilyNavigator } from "../src/lib/family-navigator.js";

test("the event names are the ADR's", () => {
  assert.equal(TAG, "family-navigator");
  assert.equal(EVENT_FOCUS, "hfy-focus");
  assert.equal(EVENT_DETAILS, "hfy-details");
});

test("hfy-focus re-centres and hfy-details opens the sheet, each with the person's id", () => {
  const target = new EventTarget();
  const calls = [];
  bindNavigatorEvents(target, { onFocus: (id) => calls.push(["focus", id]), onDetails: (id) => calls.push(["details", id]) });
  target.dispatchEvent(new CustomEvent("hfy-focus", { detail: { id: "I9001" }, bubbles: true }));
  target.dispatchEvent(new CustomEvent("hfy-details", { detail: { id: "I9002" }, bubbles: true }));
  assert.deepEqual(calls, [["focus", "I9001"], ["details", "I9002"]]);
});

test("an event without a string id is ignored, and unbinding stops both", () => {
  const target = new EventTarget();
  const calls = [];
  const unbind = bindNavigatorEvents(target, { onFocus: (id) => calls.push(id), onDetails: (id) => calls.push(id) });
  target.dispatchEvent(new CustomEvent("hfy-focus", { detail: {} }));
  target.dispatchEvent(new CustomEvent("hfy-details", { detail: null }));
  target.dispatchEvent(new CustomEvent("hfy-focus", { detail: { id: 7 } }));
  assert.deepEqual(calls, []);
  unbind();
  target.dispatchEvent(new CustomEvent("hfy-focus", { detail: { id: "I9001" } }));
  target.dispatchEvent(new CustomEvent("hfy-details", { detail: { id: "I9001" } }));
  assert.deepEqual(calls, []);
});

test("the module loads without a DOM, and defining the element where custom elements do not exist throws (the chart then falls back)", () => {
  assert.equal(typeof FamilyNavigator, "function");
  assert.throws(() => defineFamilyNavigator(), /custom elements are not available/);
});
