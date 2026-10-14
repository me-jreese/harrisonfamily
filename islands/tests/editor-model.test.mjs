// HFY-TSK-212: the editor island's pure rules (src/lib/editor-model.js): the route, the entry button, the field mode and the copy.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COPY, allBadgeText, badgeFor, createModeResolver, editHref, entryMode, parseRoute, sectionSchema, sectionValues, sectionsFor, PERSON_SECTIONS } from "../src/lib/editor-model.js";
import { EDIT_SCHEMAS } from "../src/lib/edit-schemas.js";

const policy = JSON.parse(readFileSync(new URL("./fixtures/edit-policy-person.json", import.meta.url), "utf8"));

test("parseRoute reads ?cls and ?id, defaults the class to Person and refuses odd ids", () => {
  assert.deepEqual(parseRoute("?cls=person&id=I9001"), { cls: "Person", ref: "I9001" });
  assert.deepEqual(parseRoute("?id=h:abc_1"), { cls: "Person", ref: "h:abc_1" });
  assert.deepEqual(parseRoute("?cls=EVENT&id=E0001"), { cls: "Event", ref: "E0001" });
  assert.equal(parseRoute("?cls=tag&id=T1"), null);
  assert.equal(parseRoute("?cls=person"), null);
  assert.equal(parseRoute("?id=../x"), null);
  assert.equal(editHref("Person", "I9001"), "/edit/?cls=person&id=I9001");
});

test("entryMode: own page, admin, other member, signed out, editing off", () => {
  const me = { id: "I9002", admin: false, ownRecord: { gramps_id: "I9002" }, editing: true };
  assert.equal(entryMode(me, "I9002"), "own");
  assert.equal(entryMode(me, "I9001"), "suggest");
  assert.equal(entryMode({ ...me, admin: true }, "I9001"), "admin");
  assert.equal(entryMode({ ...me, admin: true }, "I9002"), "own");
  assert.equal(entryMode({ id: null, admin: false, can: {} }, "I9001"), null);
  assert.equal(entryMode({ ...me, editing: false }, "I9001"), null);
  assert.equal(entryMode({ id: "I9002", admin: false }, "I9001"), "suggest");
});

test("the mode resolver follows the policy table", () => {
  const r = createModeResolver(policy);
  assert.equal(r.resolve("Person", "/primary_name/first_name", { relation: "own" }), "proposal");
  assert.equal(r.resolve("Person", "/primary_name/nick", { relation: "own" }), "direct");
  assert.equal(r.resolve("Person", "/primary_name/nick", { relation: "other" }), "proposal");
  assert.equal(r.resolve("Person", "/primary_name/first_name", { admin: true, relation: "other" }), "direct");
  assert.equal(r.resolve("Person", "/primary_name/sort_as", { relation: "own" }), "desk");
  assert.equal(r.resolve("Person", "/no/such/pointer", { relation: "own" }), "proposal");
  assert.equal(createModeResolver(null).resolve("Person", "/gender", {}), "proposal");
});

test("badges say it in words, and the copy is lowercase plain words", () => {
  assert.deepEqual(allBadgeText(), ["saves now", "goes to review", "only an admin can change this", "can't be changed on the site"]);
  assert.equal(badgeFor("derived").key, "locked");
  for (const text of [...Object.values(COPY), ...PERSON_SECTIONS.map((s) => s.title)]) {
    assert.ok(!/!/.test(text), text);
    assert.ok(!/\b(record|users?|members?)\b/i.test(text), text);
    assert.equal(text, text.toLowerCase());
  }
});

test("sections: the admin-only one is hidden from members; the names form is built from the Name definition", () => {
  assert.ok(!sectionsFor("Person", { admin: false }).some((s) => s.id === "more"));
  assert.ok(sectionsFor("Person", { admin: true }).some((s) => s.id === "more"));
  const names = PERSON_SECTIONS[0];
  const schema = sectionSchema(EDIT_SCHEMAS.Person, names.form);
  assert.deepEqual(Object.keys(schema.properties), ["first_name", "surname", "call", "nick", "title", "suffix"]);
  assert.equal(schema.properties.surname.title, "last name at birth");
  assert.equal(schema.properties.first_name["x-io-widget"], "givenNames");
  assert.equal(schema.properties.call["x-io-widget"], "callName");
  assert.equal(schema.properties.first_name.title, "given names");
  assert.equal(sectionSchema({}, names.form), null);
  assert.deepEqual(sectionValues({ primary_name: { first_name: "Test", nick: "", title: 3 } }, names.form), { first_name: "Test" });
});

test("conditional (`when`) rows count as the stricter answer, like the server with no context", () => {
  const p = { rows: [
    { cls: "Event", pointer: "/date/**", own: "proposal", other: "proposal", admin: "direct", when: "birthLike" },
    { cls: "Event", pointer: "/date/dateval", own: "never", other: "never", admin: "never", when: ["birthLike", "dayMonthInValue"] },
    { cls: "Event", pointer: "/description", own: "direct", other: "proposal", admin: "direct" }
  ] };
  const r = createModeResolver(p);
  assert.equal(r.resolve("Event", "/date/dateval", { relation: "own" }), "never");
  assert.equal(r.resolve("Event", "/date/other", { relation: "own" }), "proposal");
  assert.equal(r.resolve("Event", "/description", { relation: "own" }), "direct");
  assert.equal(badgeFor(r.resolve("Event", "/date/dateval", { relation: "own" })).key, "locked");
});

test("every listed form field exists in the bundled schema, so no field drops out silently", () => {
  for (const s of PERSON_SECTIONS.filter((x) => x.form)) {
    const schema = sectionSchema(EDIT_SCHEMAS.Person, s.form);
    assert.ok(schema, s.id);
    assert.deepEqual(Object.keys(schema.properties), s.form.fields.map(([k]) => k), s.id);
  }
});
