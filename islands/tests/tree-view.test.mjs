// HFY-TSK-301: the /tree/ view choice (lib/tree-view.js), in node: precedence, aliases, and a storage that throws.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VIEW, VIEW_KEY, initialView, normalizeView, readStoredView, viewParam, viewUrl, writeStoredView } from "../src/lib/tree-view.js";

const store = (initial = {}) => {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), m };
};
const throwing = () => { throw new Error("SecurityError: storage is blocked"); };
const brokenItems = () => ({ getItem: throwing, setItem: throwing });

test("normalizeView: outline, cards and the ADR's 'chart' alias; anything else is unknown", () => {
  assert.equal(normalizeView("outline"), "outline");
  assert.equal(normalizeView("cards"), "cards");
  assert.equal(normalizeView("chart"), "cards");
  for (const v of ["", "Outline", "list", null, undefined, 3]) assert.equal(normalizeView(v), null);
});

test("viewParam reads ?view= beside other parameters", () => {
  assert.equal(viewParam("?focus=I9001&view=outline"), "outline");
  assert.equal(viewParam("?view=chart"), "cards");
  assert.equal(viewParam("?view=bogus"), null);
  assert.equal(viewParam(""), null);
});

test("initialView: the address beats the stored choice, which beats the default", () => {
  const s = store({ [VIEW_KEY]: "outline" });
  assert.equal(initialView("?view=cards", () => s), "cards");
  assert.equal(initialView("?view=outline", () => store({ [VIEW_KEY]: "cards" })), "outline");
  assert.equal(initialView("", () => s), "outline");
  assert.equal(initialView("?view=nonsense", () => s), "outline");
  assert.equal(initialView("", () => store()), DEFAULT_VIEW);
  assert.equal(DEFAULT_VIEW, "cards");
});

test("a stored value we do not know is ignored", () => {
  assert.equal(readStoredView(() => store({ [VIEW_KEY]: "<script>" })), null);
});

test("writeStoredView stores the choice and reports it", () => {
  const s = store();
  assert.equal(writeStoredView("outline", () => s), true);
  assert.equal(s.m.get(VIEW_KEY), "outline");
});

test("a storage whose getter throws (blocked site data) still gives the default and never throws", () => {
  assert.equal(readStoredView(throwing), null);
  assert.equal(writeStoredView("outline", throwing), false);
  assert.equal(initialView("", throwing), "cards");
  assert.equal(initialView("?view=outline", throwing), "outline");
});

test("a storage whose getItem and setItem throw (quota, private mode) is survived too", () => {
  assert.equal(readStoredView(brokenItems), null);
  assert.equal(writeStoredView("cards", brokenItems), false);
  assert.equal(initialView("", brokenItems), "cards");
});

test("viewUrl sets view and keeps focus and the path", () => {
  assert.equal(viewUrl({ pathname: "/tree/", search: "?focus=I9001" }, "outline"), "/tree/?focus=I9001&view=outline");
  assert.equal(viewUrl({ pathname: "/tree/", search: "?view=outline&focus=I9001" }, "cards"), "/tree/?view=cards&focus=I9001");
  assert.equal(viewUrl({ pathname: "/tree/", search: "" }, "outline"), "/tree/?view=outline");
});
