// HFY-TSK-301: the /tree/ view choice (lib/tree-view.js), in node: precedence, aliases, and a storage that throws.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VIEW, TREE_TAB_NEW_UNTIL, VIEW_KEY, firstNameOf, initialView, normalizeView, readStoredView, treeAsked, treeTabIsNew, treeUrl, viewParam, viewUrl, writeStoredView } from "../src/lib/tree-view.js";

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
  assert.equal(normalizeView("table"), "table", "the table view of the lifelines (HFY-TSK-305)");
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
  assert.equal(viewUrl({ pathname: "/tree/", search: "?focus=I9001", hash: "#hfy-tree-outline" }, "outline"), "/tree/?focus=I9001&view=outline#hfy-tree-outline");
});

// HFY-TSK-379 pass 4 (familyVizHourglass): the family page's tree tab, the cards' link and the quiet "new".
test("treeUrl: view=tree and the person, from= kept from the address or given, nothing else carried, a bad id refused", () => {
  const loc = (search) => ({ pathname: "/tree/", search });
  assert.equal(treeUrl(loc("?view=cards&focus=I9007"), "I9007"), "/tree/?view=tree&focus=I9007");
  assert.equal(treeUrl(loc("?focus=I9007&from=I9005&kin=1&ggp=1&view=outline"), "I9007"), "/tree/?view=tree&focus=I9007&from=I9005");
  assert.equal(treeUrl(loc("?focus=I9007&from=I9005"), "I9007", "I9007"), "/tree/?view=tree&focus=I9007&from=I9007", "the cards' link names its own person");
  assert.equal(treeUrl(loc("?from=bad%20id"), "I9007"), "/tree/?view=tree&focus=I9007", "a from= the big tree would refuse is dropped");
  for (const bad of ["", "a b", "I9007&view=x", null, undefined, 7]) assert.equal(treeUrl(loc(""), bad), null);
  assert.equal(treeAsked(new URL(treeUrl(loc(""), "I9007"), "https://x.test").search), true, "the address is one the page reads as the big tree");
});

test("firstNameOf: the first given name, titles skipped, the name's first word otherwise, empty for nobody", () => {
  assert.equal(firstNameOf({ name: "Ada Marie Example", given: "Ada Marie" }), "Ada");
  assert.equal(firstNameOf({ name: "Dr. Bram Example" }), "Bram");
  assert.equal(firstNameOf({ name: "Cleo" }), "Cleo");
  assert.equal(firstNameOf(null), "");
  assert.equal(firstNameOf({ name: "" }), "");
});

test("treeTabIsNew: the quiet new lasts until its date and goes after it; a clock that is not a number reads as past", () => {
  const end = Date.parse(TREE_TAB_NEW_UNTIL);
  assert.equal(treeTabIsNew(end - 1000), true);
  assert.equal(treeTabIsNew(new Date(end)), true);
  assert.equal(treeTabIsNew(end + 1000), false);
  assert.equal(treeTabIsNew(Number.NaN), false);
  assert.ok(end > Date.parse("2026-11-05"), "the date is still ahead of the build that wrote it");
});
