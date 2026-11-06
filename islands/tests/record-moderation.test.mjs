// HFY-TSK-216 (hfy-moderation-record-targets): the record moderation model: targets and keys, which story is which note, the rows, the hidden set.
// Run: node --test tests/record-moderation.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { COPY, RECORDS_FLAG, applyAction, createRecordClient, hiddenSetOf, mediaTarget, mediarefTarget, noteTarget, photoRows, shownNotes, storyRows, targetKey } from "../src/lib/record-moderation.js";

test("the flag and the targets match the API's shapes", () => {
  assert.equal(RECORDS_FLAG, "moderationRecordsV1");
  assert.deepEqual(noteTarget("h1"), { kind: "note", handle: "h1" });
  assert.deepEqual(mediaTarget("m1"), { kind: "media", handle: "m1" });
  assert.deepEqual(mediarefTarget("p1", "m1"), { kind: "mediaref", person: "p1", media: "m1" });
  assert.equal(targetKey(noteTarget("h1")), "note:h1");
  assert.equal(targetKey(mediaTarget("m1")), "media:m1");
  assert.equal(targetKey(mediarefTarget("p1", "m1")), "mediaref:p1:m1");
});

test("shownNotes mirrors what the page drew: the island shows raw text, the legacy markup html or raw, and a note without a handle never gets a control", () => {
  const notes = [{ handle: "a", raw: "one" }, { handle: "b", html: "<p>two</p>" }, { handle: "c", raw: "  " }, { raw: "no handle" }, null];
  assert.deepEqual(shownNotes(notes, "island").map((n) => n.handle), ["a"]);
  assert.deepEqual(shownNotes(notes, "legacy").map((n) => n.handle), ["a", "b", "c"]); // the legacy markup draws any html or raw text, blank or not
  assert.deepEqual(shownNotes(undefined, "island"), []);
});

test("the rows follow the hidden state, in DS voice", () => {
  assert.deepEqual(storyRows({ hidden: false }).map((r) => r.id), ["hide", "request_changes", "ask"]);
  assert.deepEqual(storyRows({ hidden: true }).map((r) => r.id), ["request_changes", "ask", "unhide"]);
  const here = photoRows({ hiddenHere: false, hiddenAll: false });
  assert.deepEqual(here.map((r) => [r.label, r.input.action, r.input.scope]), [[COPY.hidePhotoHere, "hide", "mediaref"], [COPY.hidePhotoAll, "hide", "media"]]);
  const hid = photoRows({ hiddenHere: true, hiddenAll: true });
  assert.deepEqual(hid.map((r) => [r.input.action, r.input.scope]), [["unhide", "mediaref"], ["unhide", "media"]]);
  for (const r of [...here, ...hid, ...storyRows({ hidden: false })]) assert.equal(r.label, r.label.toLowerCase());
});

test("the hidden set is what the records API lists, and an action moves it without changing the old set", () => {
  assert.deepEqual([...hiddenSetOf({ hidden: ["note:a", 5, "media:m"] })], ["note:a", "media:m"]);
  assert.equal(hiddenSetOf(undefined).size, 0);
  const s = new Set(["note:a"]);
  const hid = applyAction(s, "note:b", { action: "hide" });
  assert.deepEqual([...hid].sort(), ["note:a", "note:b"]);
  assert.deepEqual([...s], ["note:a"]);
  assert.ok(applyAction(s, "note:b", { action: "request_changes", note: "x" }).has("note:b"));
  assert.ok(!applyAction(s, "note:b", { action: "ask", note: "x", hide: false }).has("note:b"));
  assert.ok(applyAction(s, "note:b", { action: "ask", note: "x", hide: true }).has("note:b"));
  assert.ok(!applyAction(hid, "note:b", { action: "unhide" }).has("note:b"));
});

test("the client posts the target and the action, a note only for the asks, never a version", async () => {
  const sent = [];
  const client = createRecordClient({ post: async (path, body) => { sent.push([path, body]); return {}; } });
  await client.act(noteTarget("h1"), { action: "hide", scope: "mediaref" });
  await client.act(mediaTarget("m1"), { action: "ask", note: " where? ", hide: true });
  assert.deepEqual(sent[0], ["/moderation", { target: { kind: "note", handle: "h1" }, action: "hide" }]);
  assert.deepEqual(sent[1], ["/moderation", { target: { kind: "media", handle: "m1" }, action: "ask", note: "where?", hide: true }]);
});
