// HFY-TSK-192 (hfy-moderation-queue-page): the pure model of /me/moderation/ on invented rows: the tabs, the state words, the page reader, paging and the unhide wording.
import { test } from "node:test";
import assert from "node:assert/strict";
import { COPY, TABS, appendPage, authorLabel, canUnhide, kindWord, listQuery, locationFor, parseTab, readPage, rowKey, safeHref, stateWords, unhideLabel, whenOf, withoutRow } from "../src/lib/moderation-queue-model.js";

const NOW = Date.parse("2026-01-10T12:00:00Z");
const row = (id, over = {}) => ({ target: { kind: "post", id }, state: "hidden", hidden: true, by: { id: "I9003", label: "Example" }, at: "2026-01-10T11:00:00Z", open: true, author: { id, label: "Sam Sample" }, href: `/posts/?id=${id}`, ...over });

test("tabs: open first, ?tab=closed picks the closed one, anything else is open", () => {
  assert.deepEqual(TABS.map((t) => t.id), ["open", "closed"]);
  assert.equal(parseTab("?tab=closed"), "closed");
  assert.equal(parseTab("?tab=nope"), "open");
  assert.equal(parseTab(""), "open");
  assert.equal(locationFor("open"), "");
  assert.equal(locationFor("closed"), "?tab=closed");
});

test("the list query names the state, a page size and the cursor only when there is one", () => {
  assert.deepEqual(listQuery("open"), { state: "open", limit: 25 });
  assert.deepEqual(listQuery("closed", "abc"), { state: "closed", limit: 25, cursor: "abc" });
});

test("state words and kinds", () => {
  assert.equal(stateWords(row("a")), "hidden");
  assert.equal(stateWords(row("a", { state: "changes_requested" })), "changes asked for, hidden");
  assert.equal(stateWords(row("a", { state: "question", hidden: false })), "question open");
  assert.equal(stateWords(row("a", { open: false, hidden: false })), "closed");
  assert.equal(kindWord({ kind: "photo" }), "photo");
  assert.equal(kindWord({ kind: "comment" }), "comment");
  assert.equal(kindWord({ kind: "odd" }), "odd");
});

test("author, when and links", () => {
  assert.equal(authorLabel(row("a")), "Sam Sample");
  assert.equal(authorLabel({ author: { id: "x" } }), COPY.someone);
  assert.equal(whenOf(row("a"), NOW), "1 hr ago");
  assert.equal(whenOf(row("a", { open: false, resolved_at: "2026-01-10T11:59:30Z" }), NOW), "just now");
  assert.equal(safeHref("/posts/?id=1"), "/posts/?id=1");
  assert.equal(safeHref("//evil.test/x"), null);
  assert.equal(safeHref("https://evil.test/"), null);
  assert.equal(safeHref(undefined), null);
});

test("unhide: a hidden item says unhide, an open question says close, a closed row has none", () => {
  assert.equal(unhideLabel(row("a")), "unhide");
  assert.equal(unhideLabel(row("a", { hidden: false })), "close");
  assert.equal(canUnhide(row("a")), true);
  assert.equal(canUnhide(row("a", { open: false })), false);
});

test("a page keeps well-formed rows, a bad body is empty, and the next page drops repeats", () => {
  assert.deepEqual(readPage(null), { items: [], cursor: null });
  assert.deepEqual(readPage({ items: [null, { x: 1 }, row("a")], cursor: "" }), { items: [row("a")], cursor: null });
  const p2 = readPage({ items: [row("a"), row("b")], cursor: "c2" });
  assert.equal(p2.cursor, "c2");
  assert.deepEqual(appendPage([row("a")], p2).map((r) => r.target.id), ["a", "b"]);
  assert.deepEqual(withoutRow([row("a"), row("b")], row("a")).map((r) => r.target.id), ["b"]);
  assert.notEqual(rowKey(row("a")), rowKey(row("b")));
});
