// HFY-TSK-379 pass 3: the addresses of the hourglass trees (lib/hourglass-links.js), walked as the round trip of T-Both: person page -> small tree -> big tree
// (centred on someone, with `from`) -> that person's page, or the family views with them in front (and the relationship panel opened) -> back. Pure: the id
// pattern is the tree page's own, and the big tree reads its start from the same address the small tree writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bigHref, listHref, ok, page } from "../src/lib/hourglass-links.js";
import { focusParam, focusUrl } from "../src/lib/tree-data.js";
import { treeLinkHref } from "../src/lib/tree-link.js";
import { initialView, normalizeView, treeAsked, viewParam } from "../src/lib/tree-view.js";

const loc = (href) => { const u = new URL(href, "https://example.test"); return { pathname: u.pathname, search: u.search, hash: u.hash }; };

test("the small tree's link to the big tree names the person and the page they came from; the big tree's start reads both back", () => {
  const href = bigHref("I9007", "I9007");
  assert.equal(href, "/tree/?view=tree&focus=I9007&from=I9007");
  const q = new URLSearchParams(loc(href).search);
  assert.deepEqual([q.get("view"), q.get("focus"), q.get("from")], ["tree", "I9007", "I9007"]);
  assert.equal(treeAsked(loc(href).search), true);
  assert.equal(focusParam(loc(href).search), "I9007", "the tree page reads the same focus");
  assert.equal(bigHref("I9007", "I9020"), "/tree/?view=tree&focus=I9007&from=I9020", "a tap on the small tree's middle person after moving: another page's person");
  assert.equal(bigHref("I9007"), "/tree/?view=tree&focus=I9007", "no page to come from (the family page): no from");
});

test("ids outside the tree page's pattern are never put in an address, in any builder", () => {
  for (const bad of ["", "a b", "../x", "x".repeat(33), "I1&focus=I2", "I1?view=cards", null, undefined, 7, {}]) {
    assert.equal(ok(bad), false, String(bad));
    assert.equal(bigHref(bad, "I9007"), null, String(bad));
    assert.equal(page(bad), null, String(bad));
  }
  assert.equal(bigHref("I9007", "bad id!"), "/tree/?view=tree&focus=I9007", "a from that does not match is left out");
  for (const id of ["I9007", "a_b-c", "x".repeat(32)]) assert.equal(ok(id) && treeLinkHref(id) !== null, true, id);
});

test("each re-centre keeps view=tree and from, and changes only focus (the address of a tap)", () => {
  const start = loc(bigHref("I9007", "I9007"));
  const next = loc(focusUrl(start, "I9008"));
  assert.equal(next.pathname + next.search, "/tree/?view=tree&focus=I9008&from=I9007");
  const again = loc(focusUrl(next, "I9010"));
  assert.equal(again.pathname + again.search, "/tree/?view=tree&focus=I9010&from=I9007");
});

test("'open X's page' and the family views name the middle person: cards, outline, table, the poster, and the relationship panel", () => {
  assert.equal(page("I9008"), "/person/?id=I9008");
  assert.equal(listHref("cards", "I9008"), "/tree/?view=cards&focus=I9008");
  assert.equal(listHref("outline", "I9008"), "/tree/?view=outline&focus=I9008");
  assert.equal(listHref("table", "I9008"), "/tree/?view=table&focus=I9008");
  assert.equal(listHref("family", "I9008"), "/tree/?view=family&focus=I9008");
  assert.equal(listHref("cards", "I9008", "&kin=1"), "/tree/?view=cards&focus=I9008&kin=1");
  // each lands on a view the tree page knows (the poster as "family"), and none is the big tree itself
  for (const v of ["cards", "outline", "table", "family"]) assert.equal(viewParam(loc(listHref(v, "I9008")).search), normalizeView(v), v);
  for (const v of ["cards", "outline", "table", "family"]) assert.equal(treeAsked(loc(listHref(v, "I9008")).search), false, v);
  assert.equal(new URLSearchParams(loc(listHref("cards", "I9008", "&kin=1")).search).get("kin"), "1");
});

test("the round trip: small tree -> big tree -> a person's page -> small tree again -> big tree", () => {
  const big1 = bigHref("I9007", "I9007");
  const tapped = focusUrl(loc(big1), "I9008"); // tap the father
  const q = new URLSearchParams(loc(tapped).search);
  const openPage = page(q.get("focus")); // "open Rowan's page"
  assert.equal(openPage, "/person/?id=I9008");
  const backOnPage = new URLSearchParams(loc(openPage).search).get("id");
  assert.equal(bigHref(backOnPage, backOnPage), "/tree/?view=tree&focus=I9008&from=I9008", "the small tree of the father's page opens the big tree on him");
  // and 'back' at the start of the stack goes to `from`: the page the visitor started on
  assert.equal(page(q.get("from")), "/person/?id=I9007");
});

test("?view=tree is not a view the toggle or the stored choice knows: it reads as an unknown view until the page decides", () => {
  assert.equal(normalizeView("tree"), null);
  assert.equal(viewParam("?view=tree"), null);
  assert.equal(initialView("?view=tree", () => ({ getItem: () => "outline" })), "outline", "flag off: what this browser remembered, as for any unknown view");
  assert.equal(initialView("?view=tree", () => ({ getItem: () => null })), "cards");
  assert.equal(treeAsked("?view=tree&focus=I1"), true);
  assert.equal(treeAsked("?view=cards"), false);
  assert.equal(treeAsked(""), false);
});
