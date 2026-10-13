// HFY-TSK-136 (HFY-PLN-002 surfaces 5.2): the /about/ call to action's copy and card logic, in node.
// Copy: lowercase, no "!", no "record", no "users" or "members". Counts and the nudge from synthetic data. One check per flag combination.
import { test } from "node:test";
import assert from "node:assert/strict";
import { allCopy, buildCards, cardModes, countsFrom, ownGap, nudgeLine, HEADING, LEDE, CLOSING } from "../src/lib/about-cta.js";
import { filterTokensFromParams, mapPerson } from "../src/lib/people-corpus.js";

const SUB = "I0042";
const COUNTS = { people: 1200, noPhoto: 340, noBirthYear: 55 };
const byId = (cards) => Object.fromEntries(cards.map((c) => [c.id, c]));

test("the deck is the surfaces 5.2 copy", () => {
  assert.equal(HEADING, "the story isn't finished.");
  assert.equal(LEDE, "it keeps going with every name, date and photo the family adds. a lot of pages are still thin, and you probably know something that isn't here yet.");
  assert.equal(CLOSING, "the memories live on.");
  assert.equal(nudgeLine("a photo"), "your page is missing a photo. start there?");
  const full = byId(buildCards({ counts: COUNTS, flags: { recordEdit: true, commentPhotosV1: true }, sub: SUB }));
  assert.equal(full.look.title, "look around");
  assert.equal(full.look.line, "1,200 people so far. find someone you remember.");
  assert.equal(full.look.action, "open the family");
  assert.equal(full.missing.title, "add what's missing");
  assert.equal(full.missing.line, "55 people don't have a birth year yet. know one? add it.");
  assert.equal(full.missing.action, "see who's missing a year");
  assert.equal(full.fix.title, "fix what's wrong");
  assert.equal(full.fix.line, "see a wrong date or a misspelled name? open that page and suggest a fix. we check it before it changes.");
  assert.equal(full.fix.action, "start with your page");
  assert.equal(full.photos.title, "add photos");
  assert.equal(full.photos.line, "340 people don't have a photo yet. a phone photo of an old print counts.");
  assert.equal(full.photos.action, "see who needs a photo");
  assert.equal(byId(buildCards({ counts: COUNTS, flags: { postsV2: true }, sub: SUB })).photos.action, "add a photo");
});

test("copy: lowercase, no '!', no 'record', no 'users' or 'members'", () => {
  const all = allCopy();
  assert.ok(all.length > 40);
  for (const s of all) {
    assert.equal(s, s.toLowerCase(), s);
    assert.ok(!s.includes("!"), s);
    assert.ok(!/\brecords?\b/.test(s), s);
    assert.ok(!/\busers?\b/.test(s) && !/\bmembers?\b/.test(s), s);
  }
});

test("a zero count swaps in the neutral line; no counts gives the count-free line", () => {
  const zeros = byId(buildCards({ counts: { people: 5, noPhoto: 0, noBirthYear: 0 }, flags: { recordEdit: true, commentPhotosV1: true }, sub: SUB }));
  assert.equal(zeros.missing.line, "every page has a birth year. nice work, family.");
  assert.equal(zeros.photos.line, "every page has a photo. nice work, family.");
  const none = byId(buildCards({ counts: null, flags: { recordEdit: true, commentPhotosV1: true }, sub: SUB }));
  for (const c of Object.values(none)) assert.ok(!/\d/.test(c.line), c.line);
  assert.equal(none.look.line, "find someone you remember.");
  const one = byId(buildCards({ counts: { people: 1, noPhoto: 1, noBirthYear: 1 }, flags: { recordEdit: true, commentPhotosV1: true }, sub: SUB }));
  assert.match(one.missing.line, /^1 person doesn't have a birth year yet/);
});

test("counts come from the family index rows, the way the search reads them", () => {
  const manifest = { people: [
    { grampsId: "I0001", displayName: "A Example", isLiving: false, lifespanSummary: "1901 - 1980", primaryPhoto: { handle: "M1" } },
    { grampsId: "I0002", displayName: "B Example", isLiving: true, lifespanSummary: "", primaryPhoto: null },
    { grampsId: "I0003", displayName: "C Example", isLiving: false, lifespanSummary: "", primaryPhoto: null },
    { notAPerson: true }
  ] };
  assert.deepEqual(countsFrom(manifest), { people: 3, noPhoto: 2, noBirthYear: 2 });
  assert.deepEqual(countsFrom(null), { people: null, noPhoto: null, noBirthYear: null });
  assert.equal(mapPerson(manifest.people[0]).fields.has_birth_year, true);
  assert.equal(mapPerson(manifest.people[1]).fields.has_birth_year, false);
});

test("the nudge names the first gap on the member's own page", () => {
  const full = { primaryPhoto: { handle: "M" }, lifespan: { birth: { year: 1900, place: { displayName: "Somewhere" } } }, notes: [{ raw: "x" }] };
  assert.equal(ownGap(full), null);
  assert.equal(ownGap({ ...full, primaryPhoto: null }), "a photo");
  assert.equal(ownGap({ ...full, lifespan: { birth: { place: { displayName: "Somewhere" } } } }), "a birth year");
  assert.equal(ownGap({ ...full, lifespan: { birth: { year: 1900 } } }), "a birthplace");
  assert.equal(ownGap({ ...full, notes: [] }), "a story");
  assert.equal(ownGap(null), null);
});

// One test per flag combination of the three target flags (recordEdit, commentPhotosV1, postsV2).
for (const recordEdit of [false, true]) for (const commentPhotosV1 of [false, true]) for (const postsV2 of [false, true]) {
  test(`flags recordEdit=${recordEdit} commentPhotosV1=${commentPhotosV1} postsV2=${postsV2}: each card is its full or its browse-only variant`, () => {
    const cards = byId(buildCards({ counts: COUNTS, flags: { recordEdit, commentPhotosV1, postsV2 }, sub: SUB }));
    assert.deepEqual(Object.keys(cards), ["look", "missing", "fix", "photos"]);
    assert.equal(cards.look.variant, "edit");
    assert.equal(cards.look.href, "/search/");
    assert.equal(cards.missing.variant, recordEdit ? "edit" : "browse");
    assert.equal(cards.fix.variant, recordEdit ? "edit" : "browse");
    assert.equal(cards.missing.href, "/search/?has_birth_year=false");
    assert.equal(cards.fix.href, "/person/?id=I0042");
    assert.equal(cards.missing.title, recordEdit ? "add what's missing" : "see what's missing");
    assert.equal(cards.fix.title, recordEdit ? "fix what's wrong" : "check your page");
    const photoFull = commentPhotosV1 || postsV2;
    assert.equal(cards.photos.variant, photoFull ? "edit" : "browse");
    assert.equal(cards.photos.title, photoFull ? "add photos" : "look at photos");
    assert.equal(cards.photos.href, commentPhotosV1 ? "/search/?has_photo=false" : postsV2 ? "/person/?id=I0042#share" : "/search/?has_photo=false");
    // a browse-only card never asks for an edit
    for (const c of Object.values(cards)) if (c.variant === "browse") assert.ok(!/\badd\b|\bsuggest\b|\bfix\b/.test(`${c.title} ${c.line} ${c.action}`), c.id);
    assert.deepEqual(cardModes({ recordEdit, commentPhotosV1, postsV2 }).edit, recordEdit);
  });
}

test("no flags at all (a flags.json without them) is the all-browse set", () => {
  for (const flags of [undefined, null, {}]) {
    const cards = buildCards({ counts: COUNTS, flags, sub: SUB });
    assert.ok(cards.filter((c) => c.id !== "look").every((c) => c.variant === "browse"));
  }
});

test("search URL contract: has_photo, has_birth_year and living accept true|false; the rest is ignored", () => {
  const tokens = filterTokensFromParams(new URLSearchParams("has_photo=false&has_birth_year=TRUE&living=false&q=x"));
  assert.deepEqual(tokens, [
    { propertyKey: "has_photo", operator: "=", value: "false" },
    { propertyKey: "has_birth_year", operator: "=", value: "true" },
    { propertyKey: "living", operator: "=", value: "false" }
  ]);
  assert.deepEqual(filterTokensFromParams(new URLSearchParams("has_photo=maybe&unknown=true&living=")), []);
});

test("death-only lifespan summaries do not count as having a birth year", () => {
  for (const lifespanSummary of ["d. 1980", "\u2013 1980", "died 1980"]) {
    const f = mapPerson({ grampsId: "I1", displayName: "Test Person", lifespanSummary }).fields;
    assert.equal(f.has_birth_year, false, lifespanSummary);
    assert.equal(f.birth_year, null, lifespanSummary);
  }
  assert.equal(mapPerson({ grampsId: "I2", displayName: "Test Person", lifespanSummary: "b. 1975" }).fields.has_birth_year, true);
  assert.equal(countsFrom([{ grampsId: "I1", displayName: "A B", lifespanSummary: "d. 1980" }]).noBirthYear, 1);
});
