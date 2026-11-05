// HFY-TSK-218: the on this day island's pure model (src/lib/onthisday-model.js). Synthetic people only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agoLine, canHide, headingForTier, promptParts, queryFor, safePhoto, viewOf } from "../src/lib/onthisday-model.js";

const P = (id, name, lifeState = "deceased") => ({ grampsId: id, name, lifeState });
const BODY = {
  date: "2026-10-13", tier: "day",
  items: [
    { id: "evt:d1", kind: "death", tone: "remember", when: "day", n: 12, year: 2014, people: [P("I0001", "Wren Brambleton")] },
    { id: "evt:m1", kind: "marriage", tone: "celebrate", when: "day", n: 50, year: 1976, people: [P("I0002", "Ada Quillfeather"), P("I0003", "Tomas Quillfeather")], emoji: "❤️" },
    { id: "evt:x", kind: "residence", tone: "neutral", when: "day", n: 3, year: 2023, place: "Springfield", people: [P("I0004", "Mary Example")] }
  ],
  posts: [], prompt: null
};

test("queryFor gives the local day and the timezone offset in minutes", () => {
  const q = queryFor(new Date(2026, 9, 3, 23, 59));
  assert.equal(q.date, "2026-10-03");
  assert.equal(q.tzOffset, new Date(2026, 9, 3).getTimezoneOffset());
});

test("headings per tier; archive and prompt fall back to the day heading", () => {
  assert.equal(headingForTier("day"), "on this day");
  assert.equal(headingForTier("week"), "this week in family history");
  assert.equal(headingForTier("year"), "this year in family history");
  assert.equal(headingForTier("archive"), "on this day");
  assert.equal(headingForTier("prompt"), "on this day");
});

test("viewOf keeps the remembering group apart and last, with the date line", () => {
  const v = viewOf(BODY);
  assert.equal(v.heading, "on this day");
  assert.equal(v.dateText, "oct 13");
  assert.deepEqual(v.rows.map((r) => r.id), ["evt:m1", "evt:x"]);
  assert.deepEqual(v.remembering.map((r) => r.id), ["evt:d1"]);
  assert.match(v.remembering[0].parts.map((p) => p.text ?? p.name).join(""), /^remembering Wren Brambleton, who died 12 years ago today\.$/);
  assert.equal(agoLine(v.rows[0]), "1976 · 50 years ago");
});

test("viewOf: nothing usable gives null; an unwordable row is dropped", () => {
  assert.equal(viewOf(null), null);
  assert.equal(viewOf({ tier: "day", items: [], posts: [], prompt: null }), null);
  assert.equal(viewOf({ tier: "day", items: [{ id: "x", kind: "marriage", tone: "celebrate", when: "day", n: 5, year: 2000, people: [P("I1", "Solo")] }] }), null);
});

test("an archive post is shaped, and an unsafe photo url is dropped", () => {
  const v = viewOf({ date: "2026-10-13", tier: "archive", items: [], posts: [{ id: "01POST", n: 1, author: { id: "I0009", label: "Ida Example" }, excerpt: "<img src=x onerror=alert(1)>", photo: { url: "javascript:alert(1)", alt: "a" } }] });
  assert.equal(v.heading, "on this day");
  assert.equal(v.post.photo, null);
  assert.equal(v.post.excerpt, "<img src=x onerror=alert(1)>"); // data; the island renders it as a text node
  assert.equal(safePhoto({ url: "/uploads/a.jpg", alt: "x" }).url, "/uploads/a.jpg");
  assert.equal(safePhoto({ url: "//evil.example/a.jpg" }), null);
});

test("the prompt: the full ask needs recordEdit, otherwise the browse-only variant", () => {
  const add = { kind: "add_day", itemId: "evt:m", people: [{ grampsId: "I1", name: "Ada Example" }, { grampsId: "I2", name: "Tomas Example" }] };
  const text = (r) => r.parts.map((p) => p.text ?? p.name).join("");
  assert.equal(promptParts(add, { recordEdit: true }).variant, "edit");
  assert.match(text(promptParts(add, { recordEdit: true })), /add it to their page\.$/);
  assert.equal(promptParts(add, { recordEdit: false }).variant, "browse");
  assert.doesNotMatch(text(promptParts(add, {})), /add it/);
  assert.match(text(promptParts({ kind: "generic" }, { recordEdit: true })), /^no dates for today yet\. know when something happened/);
  assert.doesNotMatch(text(promptParts({ kind: "generic" }, {})), /add it/);
});

test("canHide: an admin, or a person in the item", () => {
  const row = { people: [{ grampsId: "I0002" }] };
  assert.equal(canHide(row, { admin: true, sub: null }), true);
  assert.equal(canHide(row, { admin: false, sub: "I0002" }), true);
  assert.equal(canHide(row, { admin: false, sub: "I0099" }), false);
  assert.equal(canHide(row, {}), false);
});
