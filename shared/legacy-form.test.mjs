// surf-legacy-form-schema: shared/legacy-form.mjs (surfaces.md 7.3). Runs under `node --test shared/` (shared.test.mjs imports it);
// auth/test/legacy-form.test.js runs the golden mapping from src/shared/. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ERROR_CODES, FIELDS, GRAMPS, hasDigitRun, looksLikeStreet, mapToGramps, parsePlace, validateForm } from "./legacy-form.mjs";

const YEAR = 2026;
const base = () => ({
  email: "Requester@Example.test", givenNames: "Sam Alex", maidenSurname: "Sample", gender: "female", nickname: "Sammy",
  birthPlace: "Springfield, IL", birthYear: "1990", currentPlace: "Madison, WI", movedYear: "2015", everMarried: "never_married",
  university: "Example State University", graduationYear: "2012", otherDegrees: "MBA", otherInstitutions: "Sample College",
  otherDegreeYears: "2016, 2018", forSelf: true, company: "",
});
const codes = (form, opts = { year: YEAR }) => {
  const r = validateForm(form, opts);
  return r.ok ? [] : r.fields.map((f) => `${f.field}:${f.code}`);
};

test("FIELDS lists S1 and S2 with keys, labels and required flags; no gender 'other' or free-text gender field", () => {
  for (const f of FIELDS) assert.ok(f.key && f.label && typeof f.required === "boolean" && (f.section === 1 || f.section === 2), f.key);
  assert.deepEqual(FIELDS.filter((f) => f.required).map((f) => f.key),
    ["email", "givenNames", "maidenSurname", "gender", "birthPlace", "birthYear", "currentPlace", "forSelf"]);
  assert.ok(!FIELDS.some((f) => /other/i.test(f.key) && /gender/i.test(f.key)));
  assert.deepEqual(FIELDS.find((f) => f.key === "gender").options, ["male", "female"]);
});

test("a good form is ok and normalized", () => {
  const r = validateForm(base(), { year: YEAR });
  assert.equal(r.ok, true);
  assert.equal(r.value.email, "requester@example.test");
  assert.equal(r.value.birthYear, 1990);
  assert.deepEqual(r.value.otherDegreeYears, [2016, 2018]);
});

test("required fields are enforced and errors name field and code only", () => {
  const r = validateForm({}, { year: YEAR });
  assert.equal(r.ok, false);
  assert.deepEqual(r.fields.map((f) => f.field),
    ["email", "givenNames", "maidenSurname", "gender", "birthPlace", "birthYear", "currentPlace", "forSelf"]);
  for (const f of r.fields) { assert.deepEqual(Object.keys(f).sort(), ["code", "field"]); assert.ok(ERROR_CODES.includes(f.code)); }
  assert.deepEqual(codes(null), codes({}));
});

test("gender: male or female only", () => {
  assert.deepEqual(codes({ ...base(), gender: "other" }), ["gender:invalid"]);
  assert.deepEqual(codes({ ...base(), gender: "" }), ["gender:required"]);
  assert.deepEqual(codes({ ...base(), gender: "Female" }), ["gender:invalid"]);
  assert.equal(validateForm({ ...base(), genderOther: "x" }, { year: YEAR }).value.genderOther, undefined);
});

test("year regex and bounds", () => {
  for (const y of ["1899", "2100", "19x0", "199", "01990", "1990.0", " "]) assert.notEqual(codes({ ...base(), birthYear: y }).length, 0, y);
  assert.deepEqual(codes({ ...base(), birthYear: "1899" }), ["birthYear:year_format"]);
  assert.deepEqual(codes({ ...base(), birthYear: "2027" }), ["birthYear:year_range"]);
  assert.deepEqual(codes({ ...base(), birthYear: "1915", movedYear: "", graduationYear: "", otherDegreeYears: "" }), ["birthYear:year_range"]);
  assert.deepEqual(codes({ ...base(), birthYear: "1916", movedYear: "", graduationYear: "", otherDegreeYears: "" }), []);
  assert.deepEqual(codes({ ...base(), birthYear: "2026", movedYear: "", graduationYear: "", otherDegreeYears: "" }), []);
  assert.deepEqual(codes({ ...base(), movedYear: "1989" }), ["movedYear:year_range"]);
  assert.deepEqual(codes({ ...base(), movedYear: "2027" }), ["movedYear:year_range"]);
  assert.deepEqual(codes({ ...base(), graduationYear: "1999" }), ["graduationYear:year_range"]);
  assert.deepEqual(codes({ ...base(), graduationYear: "2000" }), []);
  assert.deepEqual(codes({ ...base(), otherDegreeYears: "2016, 20x8" }), ["otherDegreeYears:year_format"]);
  assert.deepEqual(codes({ ...base(), otherDegreeYears: "1980" }), ["otherDegreeYears:year_range"]);
  assert.deepEqual(codes({ ...base(), otherDegreeYears: "2001 2002 2003 2004 2005 2006" }), ["otherDegreeYears:too_many"]);
  assert.deepEqual(codes({ ...base(), otherDegreeYears: [2001, 2002] }), []);
});

test("name charset, single spaces and length", () => {
  assert.deepEqual(codes({ ...base(), givenNames: "Sam  Alex" }), ["givenNames:invalid"]);
  assert.deepEqual(codes({ ...base(), givenNames: "Sam3" }), ["givenNames:invalid"]);
  assert.deepEqual(codes({ ...base(), givenNames: "-Sam" }), ["givenNames:invalid"]);
  assert.deepEqual(codes({ ...base(), givenNames: "María-José O’Neil Jr." }), []);
  assert.deepEqual(codes({ ...base(), givenNames: "A".repeat(101) }), ["givenNames:too_long"]);
  assert.deepEqual(codes({ ...base(), maidenSurname: "B".repeat(61) }), ["maidenSurname:too_long"]);
});

test("place fields reject runs of 3+ digits and street-suffix patterns; city and state pass", () => {
  for (const p of ["Springfield, IL", "St. Louis, MO", "East St Louis, IL", "Hartford CT", "Hartford, CT", "Saint Paul, MN", "Circle, AK", "Salt Lake City, UT"]) {
    assert.deepEqual(codes({ ...base(), birthPlace: p }), [], p);
  }
  for (const p of ["Springfield 62704", "123", "Springfield, IL 627", "٦٢٧٠٤ Cairo"]) assert.deepEqual(codes({ ...base(), currentPlace: p }), ["currentPlace:digits_not_allowed"], p);
  for (const p of ["Oak Street, Springfield", "Oak St, Springfield", "Oak St., Springfield", "Elm Avenue", "Elm ave", "Pine Rd", "Maple Court, Town", "Lake Dr", "Main Hwy", "river lane", "Cedar Ct"]) {
    assert.deepEqual(codes({ ...base(), currentPlace: p }), ["currentPlace:street_not_allowed"], p);
  }
  assert.equal(hasDigitRun("ab12cd"), false);
  assert.equal(looksLikeStreet("Springfield"), false);
  assert.deepEqual(codes({ ...base(), birthPlace: "x".repeat(101) }), ["birthPlace:too_long"]);
});

test("the shared R-18 detector runs on every free-text field", () => {
  const bad = {
    givenNames: null, // charset already refuses; covered below
    nickname: "call 555-123-4567", university: "mail me at a@b.example", otherDegrees: "born 5 May", otherInstitutions: "https://wa.me/12025550100",
    birthPlace: "Springfield, IL (call me)", currentPlace: "Madison, WI",
  };
  assert.deepEqual(codes({ ...base(), nickname: bad.nickname }), ["nickname:contact_info"]);
  assert.deepEqual(codes({ ...base(), university: bad.university }), ["university:contact_info"]);
  assert.deepEqual(codes({ ...base(), otherDegrees: bad.otherDegrees }), ["otherDegrees:dob_not_allowed"]);
  assert.deepEqual(codes({ ...base(), otherInstitutions: bad.otherInstitutions }), ["otherInstitutions:contact_info"]);
  assert.deepEqual(codes({ ...base(), givenNames: "Sam a@b.example" }), ["givenNames:invalid"]);
  const r = validateForm({ ...base(), nickname: "a@b.example" }, { year: YEAR });
  assert.equal(JSON.stringify(r).includes("a@b.example"), false, "the matched text never appears in the verdict");
});

test("email, confirmation and honeypot", () => {
  assert.deepEqual(codes({ ...base(), email: "nope" }), ["email:invalid"]);
  assert.deepEqual(codes({ ...base(), email: `${"a".repeat(250)}@b.test` }), ["email:too_long"]);
  assert.deepEqual(codes({ ...base(), forSelf: false }), ["forSelf:required"]);
  assert.deepEqual(codes({ ...base(), forSelf: "no" }), ["forSelf:must_be_true"]);
  assert.deepEqual(codes({ ...base(), forSelf: "true" }), []);
  assert.deepEqual(codes({ ...base(), company: "Acme" }), ["company:not_empty"]);
  assert.deepEqual(codes({ ...base(), everMarried: "maybe" }), ["everMarried:invalid"]);
});

test("parsePlace expands state abbreviations", () => {
  assert.deepEqual(parsePlace("Springfield, IL"), { raw: "Springfield, IL", city: "Springfield", state: "Illinois" });
  assert.deepEqual(parsePlace("Springfield, Illinois"), { raw: "Springfield, Illinois", city: "Springfield", state: "Illinois" });
  assert.deepEqual(parsePlace("Springfield"), { raw: "Springfield", city: "Springfield", state: "" });
});

test("mapToGramps golden: person, events and place queries", () => {
  const m = mapToGramps(base(), { year: YEAR });
  const date = (y, modifier = 0) => ({ _class: "Date", calendar: 0, modifier, quality: 0, dateval: [0, 0, y, false], text: "", sortval: 0, newyear: 0, format: null });
  const ev = (hfyKey, type, d, description = "", extra = {}) => ({ _class: "Event", hfyKey, type: { _class: "EventType", value: type }, date: d, description, place: "", ...extra });
  assert.deepEqual(m.person, {
    _class: "Person", gender: 0,
    primary_name: {
      _class: "Name", type: { _class: "NameType", value: 2 }, first_name: "Sam Alex",
      surname_list: [{ _class: "Surname", surname: "Sample", primary: true }], nick: "Sammy",
    },
    event_ref_list: ["birth", "residence", "graduation", "degree-0", "degree-1"].map((ref) => ({ _class: "EventRef", ref, role: { _class: "EventRoleType", value: 1 } })),
    birth_ref_index: 0,
  });
  assert.deepEqual(m.events, [
    ev("birth", 12, date(1990)),
    ev("residence", 42, date(2015, 7)),
    ev("graduation", 31, date(2012), "Example State University"),
    ev("degree-0", 25, date(2016), "MBA · Sample College", { needsReview: true }),
    ev("degree-1", 25, date(2018), "MBA · Sample College", { needsReview: true }),
  ]);
  assert.deepEqual(m.placeQueries, [
    { eventKey: "birth", role: "birth", raw: "Springfield, IL", city: "Springfield", state: "Illinois" },
    { eventKey: "residence", role: "residence", raw: "Madison, WI", city: "Madison", state: "Wisconsin" },
  ]);
});

test("mapToGramps: gender codes, undated forms, Q2-11 switch, no email, no month or day", () => {
  assert.equal(GRAMPS.GENDER.male, 1);
  assert.equal(GRAMPS.GENDER.female, 0);
  assert.equal(mapToGramps({ ...base(), gender: "male" }, { year: YEAR }).person.gender, 1);
  const min = { email: "a@b.test", givenNames: "Pat", maidenSurname: "Sample", gender: "male", birthPlace: "Springfield, IL", birthYear: 2001, currentPlace: "Madison, WI", forSelf: true };
  const m = mapToGramps(min, { year: YEAR });
  assert.equal("nick" in m.person.primary_name, false);
  assert.deepEqual(m.events.map((e) => [e.type.value, e.date.modifier, e.date.dateval[2]]), [[12, 0, 2001], [42, 0, 0]]);
  const off = mapToGramps(min, { year: YEAR, storeCurrentCity: false });
  assert.deepEqual(off.events.map((e) => e.type.value), [12]);
  assert.equal(off.placeQueries.length, 1);
  const undatedDegree = mapToGramps({ ...min, otherDegrees: "BSc" }, { year: YEAR });
  assert.deepEqual(undatedDegree.events.at(-1).date.dateval, [0, 0, 0, false]);
  // no output holds an email, and every dateval has month 0 and day 0
  for (const out of [m, mapToGramps(base(), { year: YEAR })]) {
    const text = JSON.stringify(out);
    assert.equal(text.includes("@"), false);
    for (const [, d, mo, y] of text.matchAll(/"dateval":\[(\d+),(\d+),(\d+),false\]/g).map((x) => [x[0], x[1], x[2], x[3]])) {
      assert.equal(d, "0"); assert.equal(mo, "0"); assert.ok(y === "0" || /^(19|20)\d{2}$/.test(y));
    }
  }
});

test("mapToGramps refuses an invalid form", () => {
  assert.throws(() => mapToGramps({ ...base(), birthYear: "05/05/1990" }, { year: YEAR }), (e) => e.fields[0].field === "birthYear");
});
