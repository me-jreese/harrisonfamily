// The pure side of the contributions column and hero chip (HFY-TSK-189): the sentences, the names, the hidden rule, the chip rule and the
// reads. Every id and name here is synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { COPY, PAGE_SIZE, chipFor, countCopy, cursorOf, glyphOf, rowOf, rowsFor, safeHref, subjectPerson, totalOf } from "../src/lib/contrib-model.js";
import { forgetStats, readPage, readStats } from "../src/lib/contrib-api.js";

const names = new Map([["I9001", "Test Person"], ["I9003", "Ann Other"]]);
const item = (over) => ({ id: "E1", kind: "post", at: "2026-01-01T00:00:00.000Z", weight: 1, photos: 0, ref: { type: "post", id: "P1" }, href: "/posts/?id=P1", ...over });

test("count copy: singular at 1, '0 contributions' at 0, junk is 0", () => {
  assert.equal(countCopy(42), "42 contributions");
  assert.equal(countCopy(1), "1 contribution");
  assert.equal(countCopy(0), "0 contributions");
  assert.equal(countCopy(undefined), "0 contributions");
  assert.equal(countCopy(-4), "0 contributions");
  assert.equal(PAGE_SIZE, 10);
});

test("a subject names a person only as person:<id> or a bare person id", () => {
  assert.equal(subjectPerson("person:I9001"), "I9001");
  assert.equal(subjectPerson("I9001"), "I9001");
  assert.equal(subjectPerson("post:01JZ"), null);
  assert.equal(subjectPerson("proposal:01JZ"), null);
  assert.equal(subjectPerson(undefined), null);
  assert.equal(subjectPerson("person:../x"), null);
});

test("the sentences of social.md section 8, one per kind", () => {
  const post3 = rowOf(item({ photos: 3 }), names, "I9002");
  assert.equal(post3.text, "shared a post with 3 photos");
  assert.equal(rowOf(item({ photos: 1 }), names, "I9002").text, "shared a post with 1 photo");
  assert.equal(rowOf(item({ photos: 0 }), names, "I9002").text, "shared a post");
  assert.equal(rowOf(item({ kind: "self_edit", subject: "person:I9002" }), names, "I9002").text, "updated their page");
  const c = rowOf(item({ kind: "comment", subject: "person:I9001", href: "/person/?id=I9001#comment-X" }), names, "I9002");
  assert.equal(c.text, "commented on Test Person's page");
  assert.deepEqual([c.lead, c.person, c.tail], ["commented on ", { id: "I9001", name: "Test Person" }, "'s page"]);
  assert.equal(rowOf(item({ kind: "proposal_accepted", subject: "person:I9001" }), names, "I9002").text, "had a change accepted on Test Person's page");
  assert.equal(rowOf(item({ kind: "tag", subject: "person:I9003" }), names, "I9002").text, "tagged Ann Other in a photo");
  assert.equal(rowOf(item({ kind: "photo_to_record", subject: "person:I9001" }), names, "I9002").text, "their photo was added to Test Person's page");
});

test("a name that does not resolve falls back to 'a family page'; a comment on a post names no page", () => {
  const none = new Map();
  const c = rowOf(item({ kind: "comment", subject: "person:I9001" }), none, "I9002");
  assert.equal(c.text, "commented on a family page");
  assert.equal(c.person, null);
  assert.equal(rowOf(item({ kind: "proposal_accepted", subject: "person:I9001" }), none, "I9002").text, "had a change accepted on a family page");
  assert.equal(rowOf(item({ kind: "photo_to_record", subject: "person:I9001" }), none, "I9002").text, "their photo was added to a family page");
  assert.equal(rowOf(item({ kind: "tag", subject: "person:I9001" }), none, "I9002").text, "tagged someone in a photo");
  assert.equal(rowOf(item({ kind: "comment", subject: "person:I9001" }), null, "I9002").text, "commented on a family page");
  assert.equal(rowOf(item({ kind: "comment", subject: "post:01JZ" }), names, "I9002").text, "commented on a post");
  // a subject that is no person (a proposal thread) and a blank name both fall back
  assert.equal(rowOf(item({ kind: "comment", subject: "proposal:01JZ" }), names, "I9002").text, "commented on a family page");
  assert.equal(rowOf(item({ kind: "comment", subject: "person:I9001" }), new Map([["I9001", "  "]]), "I9002").text, "commented on a family page");
});

test("the comment's thread stands in for a missing subject, and an unknown kind is still a row", () => {
  assert.equal(rowOf(item({ kind: "comment", ref: { type: "comment", id: "C1", thread: "person:I9003" } }), names, "I9002").text, "commented on Ann Other's page");
  const odd = rowOf(item({ kind: "wave" }), names, "I9002");
  assert.equal(odd.text, "added something");
  assert.equal(odd.glyph, "other");
  assert.equal(glyphOf("tag"), "tag");
  assert.equal(glyphOf("self_edit"), "edit");
});

test("the row's link is the server's path; a foreign or malformed href is not followed", () => {
  assert.equal(safeHref("/person/?id=I9001#comment-X", "I9002"), "/person/?id=I9001#comment-X");
  assert.equal(safeHref("//evil.example/x", "I9002"), "/person/?id=I9002");
  assert.equal(safeHref("https://evil.example/x", "I9002"), "/person/?id=I9002");
  assert.equal(safeHref("javascript:alert(1)", "I9002"), "/person/?id=I9002");
  assert.equal(safeHref("/a b", "I9002"), "/person/?id=I9002");
  assert.equal(safeHref(undefined, "I9002"), "/person/?id=I9002");
  assert.equal(rowOf(item({ href: "//x.example" }), names, "I9002").href, "/person/?id=I9002");
});

test("unusable items are skipped", () => {
  assert.equal(rowOf(null, names, "I9002"), null);
  assert.equal(rowOf({ kind: "post" }, names, "I9002"), null);
  assert.equal(rowOf({ id: "E1" }, names, "I9002"), null);
  assert.deepEqual(rowsFor("nope", { names, ownerId: "I9002", ownerView: false }), []);
});

test("hidden entries are shown to the owner, tagged, and to nobody else", () => {
  const items = [item({ id: "A" }), item({ id: "B", hidden: true }), item({ id: "C" })];
  const owner = rowsFor(items, { names, ownerId: "I9002", ownerView: true });
  assert.deepEqual(owner.map((r) => [r.id, r.hidden]), [["A", false], ["B", true], ["C", false]]);
  const other = rowsFor(items, { names, ownerId: "I9002", ownerView: false });
  assert.deepEqual(other.map((r) => r.id), ["A", "C"]);
});

test("the chip: '0 contributions' for a member, hidden only for a record that is not a member", () => {
  assert.deepEqual(chipFor({ author: "I9002", total: 42 }, { isLiving: true }), { total: 42, text: "42 contributions" });
  assert.deepEqual(chipFor({ author: "I9002", total: 0 }, { isLiving: true }), { total: 0, text: "0 contributions" });
  assert.deepEqual(chipFor({ author: "I9002", total: 0 }, null), { total: 0, text: "0 contributions" }, "no person JSON yet: not hidden");
  assert.deepEqual(chipFor({ author: "I9002", total: 0, member: true }, { isLiving: false }), { total: 0, text: "0 contributions" });
  assert.equal(chipFor({ author: "I9002", total: 0, member: false }, { isLiving: true }), null);
  assert.equal(chipFor({ author: "I9002", total: 0 }, { isLiving: false }), null, "a deceased record with nothing credited is not a member");
  assert.deepEqual(chipFor({ author: "I9002", total: 3 }, { isLiving: false }), { total: 3, text: "3 contributions" }, "credit proves a member");
  assert.equal(chipFor(null, { isLiving: true }), null);
  assert.equal(chipFor({ total: "many" }, { isLiving: true }), null);
  assert.equal(totalOf({ total: 7.9 }), 7);
  assert.equal(totalOf({ total: -2 }), 0);
  assert.equal(cursorOf({ cursor: "abc" }), "abc");
  assert.equal(cursorOf({ cursor: null }), null);
  assert.equal(cursorOf({ cursor: "" }), null);
  assert.equal(COPY.empty, "no contributions yet.");
});

test("the reads: stats once per person, a failure is forgotten; the page asks for 10 with the cursor", async () => {
  forgetStats();
  const calls = [];
  const api = { get: async (path, opts) => { calls.push([path, opts.query]); if (path.endsWith("/stats")) return { author: opts.query.author, total: 2 }; return { items: [{ id: "E1" }], cursor: "next" }; } };
  assert.deepEqual(await readStats("I9002", api), { author: "I9002", total: 2 });
  await readStats("I9002", api);
  assert.equal(calls.filter(([p]) => p === "/contributions/stats").length, 1);
  assert.deepEqual(await readPage("I9002", {}, api), { items: [{ id: "E1" }], cursor: "next" });
  assert.deepEqual(calls.at(-1), ["/contributions", { author: "I9002", cursor: undefined, limit: 10 }]);
  await readPage("I9002", { cursor: "next", limit: 4 }, api);
  assert.deepEqual(calls.at(-1), ["/contributions", { author: "I9002", cursor: "next", limit: 4 }]);
  forgetStats();
  let n = 0;
  const flaky = { get: async () => { n += 1; if (n === 1) throw Object.assign(new Error("x"), { status: 500 }); return { total: 1 }; } };
  await assert.rejects(readStats("I9005", flaky));
  assert.deepEqual(await readStats("I9005", flaky), { total: 1 });
  assert.deepEqual(await readPage("I9002", {}, { get: async () => ({}) }), { items: [], cursor: null });
  forgetStats();
});
