// HFY-TSK-379 pass 1: the hourglass tree's data adapter (lib/hourglass-model.js) on the invented people of fixtures/tree-graph-hourglass.json,
// one test group per case of the T-Case boards, plus the small rules (words, years, names, the parent-union rule) on tiny inline graphs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CAP_CHILDREN, CAP_GRANDCHILDREN, COPY, ariaName, familyModel, firstName, indexGraph, parentUnion, partnerWord, relWord, shortName, sibText, yearsText } from "../src/lib/hourglass-model.js";
import { BIG_COPY, bigModel } from "../src/lib/hourglass-big.js";
import { initials } from "../src/lib/navigator-model.js";
import { CASES, GRAPH } from "./fixtures/hourglass-cases.mjs";

const idx = indexGraph(GRAPH);
const model = (c) => familyModel(idx, CASES[c]);
const big = (c) => bigModel(idx, CASES[c]);
const names = (cards) => cards.map((c) => c.name);

/** A tiny inline graph: people as [id, sex, birth], unions as [id, type, partners, [child ids or [id, rel]]]. */
function mini(people, unions) {
  return indexGraph({
    schemaVersion: 1,
    people: people.map(([id, sex, b, o = {}]) => ({ id, name: `${o.given || id.toUpperCase()} ${o.surname || "Sample"}`, given: o.given || id.toUpperCase(), surname: o.surname || "Sample", sex, birthYear: b, deathYear: o.d ?? null, yearApprox: !!o.approx, face: null })),
    unions: unions.map(([id, type, partners, kids = []]) => ({ id, type, partners, children: kids.map((k) => { const [c, rel = "birth"] = Array.isArray(k) ? k : [k]; return { id: c, rel: Object.fromEntries(partners.map((p) => [p, rel])) }; }) }))
  });
}

test("the fixture is the graph.json v1 minor 3 shape, with invented ids and a few faces", () => {
  assert.equal(GRAPH.schemaVersion, 1);
  assert.equal(GRAPH.minor, 3);
  for (const k of ["people", "unions", "edges", "places", "events", "components", "generations", "layout", "photoEdges", "attribution"]) assert.ok(k in GRAPH, k);
  assert.ok(GRAPH.people.every((p) => /^I9\d{3}$/.test(p.id)), "ids are I9xxx");
  const faces = GRAPH.people.filter((p) => p.face);
  assert.ok(faces.length >= 3 && faces.length < GRAPH.people.length / 4, "a few faces, most null");
  assert.ok(faces.every((p) => /^faces\/I9\d{3}-[0-9a-f]{8}\.webp$/.test(p.face)));
  assert.equal(familyModel(idx, "I0000"), null, "an id the graph does not hold gives no model");
});

test("case: a full family. two generations up (father's side then mother's), the person's row, children, grandchildren", () => {
  const m = model("full");
  assert.equal(m.focus.name, "Tamsin Alder");
  assert.equal(m.focus.aria, "Tamsin Alder, this person. open the big tree");
  assert.equal(big("full").focus.ariaBig, "Tamsin Alder, in the middle now", "the big tree's name for the middle person is added by bigModel");
  assert.equal(m.focus.ariaBig, undefined);
  assert.equal(m.noParents, false);
  assert.equal(m.empty, false);
  const [fa, mo] = m.sides;
  assert.deepEqual([fa.caption, mo.caption], ["father's side", "mother's side"]);
  assert.deepEqual([fa.parent.word, mo.parent.word], ["father", "mother"]);
  assert.equal(fa.parent.aria, "Rowan Alder, father");
  assert.deepEqual(names(fa.grandparents), ["Silas Alder", "Mabry Fennick"], "father slot first");
  assert.deepEqual(fa.grandparents.map((g) => g.word), ["grandfather", "grandmother"]);
  assert.equal(fa.grandparents[1].aria, "Mabry Fennick, grandmother, father's side");
  assert.equal(mo.grandparents[0].aria, "Edmund Birchwood, grandfather, mother's side");
  assert.deepEqual(m.both, { ids: [], shared: [], note: null });
  assert.equal(m.siblings.text, "1 brother");
  assert.equal(m.siblings.list[0].half, false);
  assert.deepEqual(m.partners.map((p) => [p.name, p.word]), [["Hugo Larkspur", "husband"]]);
  assert.deepEqual(names(m.children.list), ["Wren Larkspur", "Orrin Larkspur", "Sefa Larkspur"]);
  assert.deepEqual(m.children.list.map((c) => c.word), ["daughter", "son", "child"], "an adopted child reads like a birth child; no sex gives the neutral word");
  assert.equal(m.children.moreText, "");
  assert.deepEqual(names(m.grandchildren.list), ["Ivy Hollin", "Jory Hollin", "Kit Larkspur"]);
  assert.equal(m.grandchildren.list[2].aria, "Kit Larkspur, grandchild, Orrin's child");
  assert.equal(m.grandchildren.list[0].aria, "Ivy Hollin, granddaughter, Wren's daughter");
  assert.equal(m.grandchildren.namesText, "grandchildren: Ivy, Jory and Kit");
  assert.equal(m.grandchildren.more, 0);
  assert.equal(m.grandchildren.moreAria, "");
  assert.ok(m.focus.face && m.sides[0].parent.face, "the people with a face crop carry its url");
  assert.match(m.focus.face, /^\/media\/faces\/I9007-[0-9a-f]{8}\.webp$/);
  assert.equal(m.sides[1].parent.face, null);
});

test("case: one parent only. the known side keeps its caption and two generations; the other is a ghost with no caption", () => {
  const m = model("oneParent");
  const [fa, mo] = m.sides;
  assert.equal(m.noParents, false);
  assert.equal(fa.caption, null);
  assert.deepEqual([fa.parent.ghost, fa.parent.text, fa.grandparents, fa.parentsGhost], [true, "father not known yet.", null, null]);
  assert.equal(mo.caption, "mother's side");
  assert.equal(mo.parent.name, "Nell Oakley");
  assert.deepEqual(names(mo.grandparents), ["Barnaby Meadowby", "Coralie Northam"]);
  assert.equal(mo.parentsGhost, null);
  assert.equal(m.siblings.count, 0);
  assert.equal(m.siblings.text, "");
});

test("case: no parents. one ghost for both, no sides, and the partner of a custom union reads partner", () => {
  const m = model("noParents");
  assert.equal(m.noParents, true);
  assert.equal(m.sides, null);
  assert.deepEqual([m.parentsGhost.ghost, m.parentsGhost.text, m.parentsGhost.tell], [true, "parents not known yet.", true]);
  assert.deepEqual(m.partners.map((p) => [p.name, p.word, p.type]), [["Ansa Dunmere", "partner", "custom"]]);
  assert.deepEqual(m.children.list.map((c) => [c.name, c.word]), [["Fen Pennywell", "child"]]);
  assert.equal(m.blocks[0].partner, 0);
  assert.equal(m.siblings.count, 0);
  const alone = model("alone");
  assert.equal(alone.empty, true);
  assert.equal(alone.focus.years, "", "no year at all gives no years line");
  assert.deepEqual([alone.partners.length, alone.blocks.length, alone.children.list.length, alone.grandchildren.list.length], [0, 0, 0, 0]);
});

test("case: a large family. nine children sorted by birth year, the cap of four, '+5 more children', and the six-grandchild cap", () => {
  const m = model("large");
  assert.equal(m.children.list.length, 9);
  assert.equal(m.children.cap, CAP_CHILDREN);
  assert.equal(m.children.list.length - m.children.cap, 5);
  assert.equal(m.children.moreText, "+5 more children");
  const years = m.children.list.map((c) => c.years);
  assert.deepEqual(years, ["b. 1964", "b. 1966", "b. 1967", "b. 1970", "b. 1972", "b. 1975", "b. 1977", "b. 1979", "b. 1981"], "oldest first even though the file lists them out of order");
  assert.equal(m.grandchildren.list.length, 9);
  assert.equal(CAP_GRANDCHILDREN, 6);
  assert.deepEqual([m.grandchildren.shown, m.grandchildren.more], [5, 4], "over six: five and a chip");
  assert.equal(m.grandchildren.namesText, "grandchildren: Arlo, Briar, Cyril, Dove, Ezra and 4 more");
  assert.equal(m.grandchildren.moreAria, "4 more grandchildren. open the big tree");
  const last = m.grandchildren.list.slice(-4).map((g) => g.name);
  assert.deepEqual(last, ["Faye Quillon", "Gus Quillon", "Hale Quillon", "Imre Quillon"], "a grandchild with no birth year sorts after the dated ones of the same parent");
  const long = m.children.list.find((c) => c.name.startsWith("Evangeline"));
  assert.equal(long.short, "Evangeline Thistledown-Pennywell");
  assert.equal(long.first, "Evangeline");
  assert.equal(long.initials, "ET");
  assert.equal(m.grandchildren.list.find((g) => g.name === "Imre Quillon").years, "");
});

test("case: brothers and sisters opened. full and half, half flagged with the side and the shared parent; sorted by birth year", () => {
  const m = model("siblings");
  const s = m.siblings;
  assert.equal(s.count, 6);
  assert.equal(s.text, "6 brothers and sisters");
  assert.deepEqual(s.list.map((c) => c.name), ["Cecily Kestrel", "Emrys Kestrel", "Jessamy Rowanford", "Kai Rowanford", "Gareth Kestrel", "Hilda Kestrel"]);
  assert.deepEqual(s.list.map((c) => c.word), ["sister", "brother", "half sister, mother's side", "half sibling, mother's side", "half brother, father's side", "half sister, father's side"]);
  assert.deepEqual(s.list.map((c) => c.half), [false, false, true, true, true, true]);
  assert.deepEqual(s.list.map((c) => c.halfSide), [null, null, 1, 1, 0, 0]);
  const [father, mother] = m.sides.map((x) => x.parent.id);
  assert.deepEqual(s.list.map((c) => c.via), [null, null, mother, mother, father, father]);
  assert.equal(s.list[4].aria, "Gareth Kestrel, half brother, father's side");
  assert.notEqual(s.list[4].unionId, s.list[0].unionId, "a half-sibling belongs to the parent's other union");
  assert.equal(big("siblings").sides[0].others, undefined, "the parents' other partners are cut (the budget, io's order), in the big tree's model too");
  // Father's parents are recorded, mother's are not.
  assert.equal(m.sides[0].grandparents.length, 2);
  assert.equal(m.sides[1].grandparents, null);
  assert.equal(m.sides[1].parentsGhost.text, "her parents not known yet.");
  assert.equal(m.sides[0].parentsGhost, null);
});

test("sibText: one, all brothers, all sisters, mixed, none", () => {
  assert.equal(sibText([{ sex: "m" }]), "1 brother");
  assert.equal(sibText([{ sex: "f" }]), "1 sister");
  assert.equal(sibText([{ sex: "u" }]), "1 sibling");
  assert.equal(sibText([{ sex: "m" }, { sex: "m" }, { sex: "m" }]), "3 brothers");
  assert.equal(sibText([{ sex: "f" }, { sex: "f" }]), "2 sisters");
  assert.equal(sibText([{ sex: "f" }, { sex: "m" }]), "2 brothers and sisters");
  assert.equal(sibText([{ sex: "f" }, { sex: "u" }]), "2 brothers and sisters");
  assert.equal(sibText([]), "");
});

test("case: the same ancestors on both sides. brother and sister as grandparents give the note and the tags (the great-grandparents of the big tree are cut)", () => {
  const m = big("pedigree");
  assert.equal(m.both.shared.length, 1);
  assert.equal(m.both.note.text, "Delphine and Everett were sister and brother, so Gideon Eastlake and Ottoline Juniper are on both sides of this family.");
  assert.equal(m.both.note.button, "see them in the outline");
  const gps = m.sides.flatMap((s) => s.grandparents);
  const tagged = gps.filter((g) => g.both).map((g) => g.name);
  assert.deepEqual(tagged, ["Delphine Eastlake", "Everett Eastlake"]);
  assert.equal(gps.find((g) => g.name === "Delphine Eastlake").aria, "Delphine Eastlake, grandmother, father's side, on both sides of the family");
  assert.equal(gps.filter((g) => !g.both).every((g) => !/both sides/.test(g.aria)), true);
  assert.equal(m.ggp, undefined, "no great-grandparent union in the model: the row is cut");
});

test("the both-sides note names every brother and sister among the grandparents, not only the first two", () => {
  // Three of the four grandparents are children of one couple (invented names): ga, gc and gd. The note lists them as they stand: father's side, then mother's, a man before a woman in a couple.
  const idx3 = mini(
    [["x", "u", 2000], ["f", "m", 1970, { given: "Fenn" }], ["m", "f", 1972, { given: "Mara" }], ["ga", "m", 1940, { given: "Ansel" }], ["gb", "f", 1942, { given: "Bryn", surname: "Other" }], ["gc", "f", 1944, { given: "Cora" }], ["gd", "m", 1946, { given: "Dov" }], ["z1", "m", 1910, { given: "Zed" }], ["z2", "f", 1912, { given: "Zia" }]],
    [["u0", "married", ["f", "m"], ["x"]], ["ua", "married", ["ga", "gb"], ["f"]], ["ub", "married", ["gc", "gd"], ["m"]], ["uz", "married", ["z1", "z2"], ["ga", "gc", "gd"]]]
  );
  const m = familyModel(idx3, "x");
  assert.equal(m.both.shared.length, 1);
  assert.deepEqual(m.both.shared[0].kids.sort(), ["ga", "gc", "gd"]);
  assert.equal(m.both.note.text, "Ansel, Dov and Cora were siblings, so Zed and Zia Sample are on both sides of this family.");
  // The same sex reads brothers or sisters; one shared couple with a missing member says "is".
  const bros = mini(
    [["x", "u", 2000], ["f", "m", 1970], ["m", "f", 1972], ["ga", "m", 1940], ["gb", "f", 1942], ["gc", "m", 1944], ["gd", "f", 1946], ["z1", "m", 1910, { given: "Zed" }]],
    [["u0", "married", ["f", "m"], ["x"]], ["ua", "married", ["ga", "gb"], ["f"]], ["ub", "married", ["gc", "gd"], ["m"]], ["uz", "married", ["z1"], ["ga", "gc"]]]
  );
  assert.match(familyModel(bros, "x").both.note.text, /^GA and GC were brothers, so Zed Sample is on both sides of this family\.$/);
});

test("case: a grandparent who stands under both parents is tagged on both sides, and has no note (no brother or sister to name)", () => {
  const m = model("bothSides");
  const [a, b] = m.sides.map((s) => s.grandparents.find((g) => g.name === "Torin Glenhart"));
  assert.ok(a && b, "drawn under each side");
  assert.deepEqual([a.both, b.both], [true, true]);
  assert.equal(a.aria, "Torin Glenhart, grandfather, father's side, on both sides of the family");
  assert.equal(b.aria, "Torin Glenhart, grandfather, mother's side, on both sides of the family");
  assert.equal(m.both.ids.length, 1);
  assert.equal(m.both.note, null);
  assert.equal(m.sides.flatMap((s) => s.grandparents).filter((g) => g.both).length, 2);
});

test("case: a person with several partners. union order, spouse words only for married, 'also with', children say with whom", () => {
  const m = model("partners");
  assert.deepEqual(m.partners.map((p) => [p.name, p.word]), [["Alma Pennywell", "wife"], ["Beatrix Oakley", "partner"], ["Cleo Fennick", "partner"], ["Dale Ivorton", "partner"]]);
  assert.deepEqual(m.partners.map((p) => p.type), ["married", "unmarried", "civil_union", "unknown"]);
  assert.deepEqual(m.children.list.map((c) => c.word), ["son with Alma", "daughter with Alma", "son with Beatrix"]);
  assert.deepEqual(m.blocks.map((b) => b.partner), [0, 1]);
  assert.deepEqual(m.blocks.map((b) => b.kids.length), [2, 1]);
  assert.equal(m.partners.slice(2).length, 2, "partners three and four are the 'also with' chips");
  assert.deepEqual(m.siblings.list.map((c) => [c.name, c.word]), [["Sibyl Dunmere", "half sister, father's side"]]);
  // A mother's own parents recorded with the mother alone: the father slot is a ghost, the mother's slot a card.
  assert.deepEqual(m.sides[1].grandparents.map((g) => (g.ghost ? g.text : `${g.name}, ${g.word}`)), ["not known yet.", "Odalys Fennick, grandmother"]);
  assert.equal(m.sides[1].parentsGhost, null);
});

test("parent union rule: the union with a birth link wins even when listed second; with none, the first", () => {
  const born = model("adoptedBirth");
  assert.deepEqual(names(born.sides.map((s) => s.parent)), ["Silvan Juniper", "Rhoda Juniper"], "birth parents, father slot first");
  assert.equal(born.siblings.count, 0);
  const none = model("adoptedFirst");
  assert.deepEqual(names(none.sides.map((s) => s.parent)), ["Quentin Cobbler", "Prudence Cobbler"], "no birth link anywhere: the first union");
  assert.deepEqual(none.siblings.list.map((c) => [c.name, c.word]), [["Rhys Cobbler", "brother"]], "an adopted brother reads brother");
  const u = parentUnion(idx, CASES.adoptedBirth);
  assert.equal(Object.values(u.rel.get(CASES.adoptedBirth)).includes("birth"), true);
  assert.equal(parentUnion(idx, CASES.noParents), null);
});

test("a union with a birth link is chosen on a tiny graph too, and a union with no recorded partner is never a parent union", () => {
  const g = mini([["a", "m", 1900], ["b", "f", 1902], ["c", "m", 1904], ["d", "f", 1930]], [["u1", "unknown", [], ["d"]], ["u2", "married", ["a", "b"], [["d", "adopted"]]], ["u3", "married", ["c", "b"], [["d", "foster"]]]]);
  assert.equal(parentUnion(g, "d").id, "u2", "the first with a recorded partner, no birth link");
  const g2 = mini([["a", "m", 1900], ["b", "f", 1902], ["c", "m", 1904], ["d", "f", 1930]], [["u2", "married", ["a", "b"], [["d", "adopted"]]], ["u3", "married", ["c", "b"], ["d"]]]);
  assert.equal(parentUnion(g2, "d").id, "u3");
});

test("father and mother slots: the male partner is the father; same or unrecorded sex keeps the file order; a one-parent union leaves the other slot empty", () => {
  const g = mini(
    [["m1", "f", 1900], ["f1", "m", 1900], ["x1", "u", 1900], ["x2", "u", 1901], ["w", "f", 1902], ["w2", "f", 1903], ["k1", "u", 1930], ["k2", "u", 1931], ["k3", "u", 1932], ["k4", "u", 1933], ["k5", "u", 1934]],
    [["a", "married", ["m1", "f1"], ["k1"]], ["b", "unknown", ["x1", "x2"], ["k2"]], ["c", "unknown", ["w", "w2"], ["k3"]], ["d", "unknown", ["w"], ["k4"]], ["e", "unknown", ["f1"], ["k5"]]]
  );
  const slots = (kid) => parentUnion(g, kid).slots;
  assert.deepEqual(slots("k1"), ["f1", "m1"], "listed mother first: still father first");
  assert.deepEqual(slots("k2"), ["x1", "x2"]);
  assert.deepEqual(slots("k3"), ["w", "w2"]);
  assert.deepEqual(slots("k4"), [null, "w"]);
  assert.deepEqual(slots("k5"), ["f1", null]);
  const m = familyModel(g, "k4");
  assert.equal(m.sides[0].parent.text, "father not known yet.");
  assert.equal(m.sides[1].parent.name, "W Sample");
});

test("rows are de-duplicated by id: a partner with two unions, a child listed twice, a half-sibling reached from both parents", () => {
  const g = mini(
    [["p", "m", 1950], ["q", "f", 1952], ["r", "f", 1975], ["s", "m", 1977], ["t", "m", 1998], ["a", "m", 1920], ["b", "f", 1922]],
    [["u1", "unmarried", ["p", "q"], ["r"]], ["u2", "married", ["p", "q"], ["s", "r"]], ["u3", "married", ["a", "b"], ["p"]], ["u4", "married", ["r"], ["t"]], ["u5", "unknown", ["s"], ["t"]]]
  );
  const m = familyModel(g, "p");
  assert.equal(m.partners.length, 1, "one card for the partner of two unions");
  assert.equal(m.partners[0].type, "married", "married when any union with them is");
  assert.equal(m.partners[0].word, "wife");
  assert.deepEqual(m.children.list.map((c) => c.id), ["r", "s"], "r is listed in both unions and shown once");
  assert.deepEqual(m.grandchildren.list.map((c) => c.id), ["t"], "t is the child of two of the children and shown once");
  const sib = familyModel(g, "r");
  assert.deepEqual(sib.siblings.list.map((c) => [c.id, c.half]), [["s", false]], "another union of the same two parents makes a full sibling");
});

test("ids the graph does not hold are dropped from every union; a person with only such links has no parents", () => {
  const g = indexGraph({ schemaVersion: 1, people: [{ id: "a", name: "A Sample", sex: "f" }], unions: [{ id: "u", type: "married", partners: ["a", "ghost"], children: [{ id: "x", rel: {} }, { id: "a", rel: {} }] }] });
  const m = familyModel(g, "a");
  assert.equal(m.partners.length, 0);
  assert.equal(m.children.list.length, 0);
  assert.ok(m, "broken data (a person their own parent) builds a model and nothing loops");
  const lone = indexGraph({ schemaVersion: 1, people: [{ id: "z", name: "Z Sample", sex: "m" }], unions: [{ id: "u", type: "married", partners: ["nobody"], children: [{ id: "z", rel: {} }] }] });
  assert.equal(familyModel(lone, "z").noParents, true);
});

test("indexGraph takes a FamilyGraph (its .data) as well as the body", () => {
  const withData = indexGraph({ data: GRAPH });
  assert.equal(withData.people.size, idx.people.size);
});

test("relWord: every kind in the three columns, from the sex alone", () => {
  const table = {
    parent: ["father", "mother", "parent"], gp: ["grandfather", "grandmother", "grandparent"],
    sib: ["brother", "sister", "sibling"], half: ["half brother", "half sister", "half sibling"], child: ["son", "daughter", "child"], gk: ["grandson", "granddaughter", "grandchild"],
    wed: ["husband", "wife", "spouse"]
  };
  for (const [kind, [m, f, u]] of Object.entries(table)) {
    assert.equal(relWord(kind, "m"), m);
    assert.equal(relWord(kind, "f"), f);
    assert.equal(relWord(kind, "u"), u);
    assert.equal(relWord(kind, undefined), u);
    assert.equal(relWord(kind, "x"), u);
  }
});

test("partnerWord: only married gets spouse words; every other union type reads partner", () => {
  assert.equal(partnerWord("married", "m"), "husband");
  assert.equal(partnerWord("married", "f"), "wife");
  assert.equal(partnerWord("married", "u"), "spouse");
  for (const t of ["unmarried", "civil_union", "unknown", "custom", undefined]) for (const s of ["m", "f", "u"]) assert.equal(partnerWord(t, s), "partner", `${t} ${s}`);
});

test("an adopted, step or foster child reads like a birth child (REPORT G6)", () => {
  const g = mini([["p", "m", 1950], ["a", "f", 1975], ["b", "m", 1977], ["c", "f", 1979]], [["u", "unknown", ["p"], [["a", "adopted"], ["b", "step"], ["c", "foster"]]]]);
  assert.deepEqual(familyModel(g, "p").children.list.map((c) => c.word), ["daughter", "son", "daughter"]);
  assert.equal(familyModel(g, "p").children.list[0].aria, "A Sample, daughter");
});

test("yearsText: a range, birth only, death only, nothing; c. before an approximate year; never a word for a missing year", () => {
  assert.equal(yearsText({ birthYear: 1880, deathYear: 1942 }), "1880–1942");
  assert.equal(yearsText({ birthYear: 1950, deathYear: null }), "b. 1950");
  assert.equal(yearsText({ birthYear: null, deathYear: 1942 }), "d. 1942");
  assert.equal(yearsText({ birthYear: null, deathYear: null }), "");
  assert.equal(yearsText({}), "");
  assert.equal(yearsText({ birthYear: 1880, deathYear: 1942, yearApprox: true }), "c. 1880–1942");
  assert.equal(yearsText({ birthYear: 1880, deathYear: null, yearApprox: true }), "b. c. 1880");
  assert.equal(yearsText({ birthYear: 1950, deathYear: null, living: true }), "b. 1950", "living is never said");
  for (const p of GRAPH.people) assert.doesNotMatch(yearsText(p), /unknown|living|deceased/i);
});

test("names: first name, short name and initials", () => {
  assert.equal(firstName({ given: "Rosalind Marguerite", name: "Rosalind Marguerite Quillon-Ashby" }), "Rosalind");
  assert.equal(firstName({ given: "Rev. Amos", name: "Rev. Amos Sample" }), "Amos", "a title is dropped");
  assert.equal(firstName({ name: "Solo" }), "Solo");
  assert.equal(shortName({ given: "Rosalind Marguerite Evangeline", surname: "Quillon-Ashby", name: "ignored" }), "Rosalind Quillon-Ashby");
  assert.equal(shortName({ name: "One Two Three Four" }), "One Four", "without given and surname: the first and last word");
  assert.equal(shortName({ name: "Cher" }), "Cher");
  assert.equal(shortName({ given: "Ada", name: "Ada Example" }), "Ada Example");
  assert.equal(initials({ given: "Rosalind", surname: "Quillon-Ashby" }), "RQ");
  assert.equal(initials({ name: "Ada Example" }), "AE");
  assert.equal(initials({ name: "" }), "?");
});

test("ariaName joins the name and the parts that are there", () => {
  assert.equal(ariaName("Ada Example", "mother"), "Ada Example, mother");
  assert.equal(ariaName("Ada Example", "grandmother", "father's side", false, "on both sides of the family"), "Ada Example, grandmother, father's side, on both sides of the family");
  assert.equal(ariaName("Ada Example"), "Ada Example");
});

test("every person of the fixture builds a model with a card for each role the words name", () => {
  for (const p of GRAPH.people) {
    const m = bigModel(idx, p.id);
    assert.ok(m, p.id);
    assert.equal(m.focus.id, p.id);
    assert.equal(m.empty, !m.sides && !m.partners.length && !m.children.list.length && !m.siblings.count);
    const cards = [...(m.sides || []).flatMap((s) => [s.parent, ...(s.grandparents || [])]), ...m.siblings.list, ...m.partners, ...m.children.list, ...m.grandchildren.list];
    for (const c of cards.filter((x) => !x.ghost)) {
      assert.ok(c.name && c.short && c.word && c.aria.startsWith(c.name), `${p.id}: ${c.id}`);
      assert.ok(/^[A-Z?]{1,2}$/.test(c.initials), `${p.id}: initials of ${c.id}`);
      assert.notEqual(c.id, p.id, "the focus person is in no other row");
    }
    for (const rows of [m.siblings.list, m.partners, m.children.list, m.grandchildren.list]) assert.equal(new Set(rows.map((c) => c.id)).size, rows.length, `${p.id}: a row repeats a person`);
  }
});

test("COPY holds the verbatim strings the model hands out", () => {
  assert.deepEqual(COPY.sides, ["father's side", "mother's side"]);
  assert.equal(COPY.notKnown, "not known yet.");
  assert.equal(COPY.parentsNotKnown, "parents not known yet.");
  assert.deepEqual(COPY.parentNotKnown, ["father not known yet.", "mother not known yet."]);
  assert.equal(COPY.grandparentsNotKnown.m, "his parents not known yet.");
  assert.equal(COPY.grandparentsNotKnown.f, "her parents not known yet.");
  assert.equal(COPY.tellUs, "know who? tell us");
  assert.equal(COPY.moreChildren(5), "+5 more children");
  assert.equal(COPY.fewer, "show fewer");
  assert.equal(COPY.also, "also with");
  assert.equal(COPY.openBig, "open the big tree");
  assert.equal(COPY.openBigAria("Bram Example"), "open the big tree, centred on Bram Example");
  assert.equal(COPY.showSiblings("4 brothers and sisters"), "4 brothers and sisters. show them");
  assert.equal(COPY.hideSiblings, "hide brothers and sisters");
  assert.equal(BIG_COPY.moreOfChildren(2, "Ada"), "2 more of Ada's children. put Ada in the middle");
  assert.equal(COPY.moreGrandchildren(2), "2 more grandchildren. open the big tree");
  assert.deepEqual([-2, -1, 1, 2].map((g) => BIG_COPY.rows[g]), ["grandparents", "parents", "children", "grandchildren"]);
});
