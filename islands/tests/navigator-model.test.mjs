// HFY-TSK-145 (viz-mvp-visual): navigatorModel and detailsModel (lib/navigator-model.js) in node, on the messy synthetic graph
// tests/fixtures/tree-graph-messy.json (invented names): two partner families plus a one-parent family and one with an excluded partner,
// a mother-only parent union, a parentless sibling group, every rel value, a private-excluded person, approximate and unknown years, a
// place chain with a cycle and a dangling id, and a singleton that sits alone in its own component at generation 0 (as the builder emits).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseGraph } from "../src/lib/family-graph.js";
import { COPY, detailsModel, faceUrl, initials, navigatorModel, placeChain, placeLine } from "../src/lib/navigator-model.js";

const g = parseGraph(readFileSync(new URL("./fixtures/tree-graph-messy.json", import.meta.url), "utf8"));
const ids = (cards) => cards.map((c) => c.id);

test("an unknown focus has no model", () => {
  assert.equal(navigatorModel(g, "I0000"), null);
  assert.equal(detailsModel(g, "I0000"), null);
});

test("the focus card: face, name, years in words, one place line from the real place chain", () => {
  const m = navigatorModel(g, "I8001");
  assert.equal(m.focus.name, "Robin Quill");
  assert.equal(m.focus.face, "/media/faces/I8001-1a2b3c4d.webp");
  assert.equal(m.focus.years, "1952 to 2020");
  assert.equal(m.focus.place, "born in Riverton, Marlow County, Examplestate");
  assert.equal(m.focus.label, "Robin Quill, focus, 1952 to 2020, show details");
  assert.equal(m.connected, true);
  assert.equal(m.notice, null);
});

test("years in words: approximate, unknown, living, death only", () => {
  assert.equal(navigatorModel(g, "I8003").focus.years, "about 1928 to unknown");
  assert.equal(navigatorModel(g, "I8010").focus.years, "years unknown");
  assert.equal(navigatorModel(g, "I8020").focus.years, "born 1978");
  assert.equal(navigatorModel(g, "I8011").focus.years, "about 1951 to unknown");
});

test("initials stand in when there is no face, and a bad face path is never used (no guessed crop)", () => {
  const m = navigatorModel(g, "I8004");
  assert.equal(m.focus.face, null);
  assert.equal(m.focus.initials, "PQ");
  assert.equal(faceUrl("faces/I8001-1a2b3c4d.webp"), "/media/faces/I8001-1a2b3c4d.webp");
  for (const bad of [null, undefined, "", "faces/../x.webp", "http://x.example/a.webp", "faces/a b.webp", "faces/a.png", "media/faces/a.webp", 7]) assert.equal(faceUrl(bad), null, String(bad));
  assert.equal(initials({ name: "Mono" }), "M");
  assert.equal(initials({ name: "Ada B Example" }), "AE");
  assert.equal(initials({ given: "ada", surname: "example", name: "x" }), "AE");
  assert.equal(initials({ name: "" }), "?");
});

test("place chains: leaf first, at most three parts, a cycle or a dangling id never loops or invents a place", () => {
  assert.equal(placeChain(g, "P8003"), "Riverton, Marlow County, Examplestate");
  assert.equal(placeChain(g, "P8002"), "Marlow County, Examplestate");
  assert.equal(placeChain(g, "P8004"), "Loopville, Loopshire"); // P8004 and P8005 name each other as parent
  assert.equal(placeChain(g, "P8999"), null);
  assert.equal(placeChain(g, null), null);
  assert.equal(placeLine(g, g.person("I8002")), null); // dangling birth place
  assert.equal(placeLine(g, g.person("I8003")), "born in Loopville, Loopshire");
  assert.equal(placeLine(g, g.person("I8020")), null); // living: no place line
});

test("the parents strip: two cards; one parent is a dashed placeholder; none is 'parents not recorded yet'", () => {
  const two = navigatorModel(g, "I8001").parents;
  assert.deepEqual(ids(two.cards), ["I8002", "I8003"]);
  assert.equal(two.placeholder, null);
  assert.equal(two.message, null);
  assert.deepEqual(two.cards.map((c) => c.role), ["father", "mother"]);
  // a mother-only union: the one recorded parent, then the placeholder
  const one = navigatorModel(g, "I8030").parents;
  assert.deepEqual(ids(one.cards), ["I8031"]);
  assert.equal(one.placeholder, COPY.parentMissing);
  assert.equal(one.placeholder, "parent not recorded");
  const none = navigatorModel(g, "I8002").parents;
  assert.deepEqual(none.cards, []);
  assert.equal(none.message, "parents not recorded yet");
});

test("one entry per union: 'with <partner>' or 'partner not recorded', the partner card and that union's children", () => {
  const u = navigatorModel(g, "I8001").unions;
  assert.deepEqual(u.map((x) => x.tab), ["with Uma Vale", "with Vic Rowe", "partner not recorded", "partner not recorded"]);
  assert.deepEqual(u.map((x) => x.id), ["F8003", "F8004", "F8005", "F8006"]);
  assert.deepEqual([u[0].partner.role, u[1].partner.role], ["wife", "partner"]);
  assert.equal(u[2].partner, null);
  assert.equal(u[3].partner, null); // the partner is private-excluded: absent, not a blank card
  assert.deepEqual(ids(u[0].children), ["I8020", "I8021"]); // I8999 is not in the graph
  assert.equal(navigatorModel(g, "I8002").unions.length, 2);
  assert.deepEqual(navigatorModel(g, "I8002").unions.map((x) => x.tab), ["with Tess Marlow", "with Una Dale"]);
  assert.deepEqual(navigatorModel(g, "I8004").unions, []);
});

test("a private-excluded person is absent everywhere", () => {
  const all = JSON.stringify([navigatorModel(g, "I8001"), navigatorModel(g, "I8002"), navigatorModel(g, "I8043"), detailsModel(g, "I8001")]);
  for (const hidden of ["I8999", "I8998", "I8997"]) assert.ok(!all.includes(hidden), hidden);
});

test("every rel value: adopted, step and foster get a text badge and a word in the name; the rest show none", () => {
  const kids = Object.fromEntries(navigatorModel(g, "I8001").unions.flatMap((x) => x.children).map((c) => [c.id, c]));
  assert.deepEqual(kids.I8020.badges, []); // birth
  assert.deepEqual(kids.I8021.badges, ["adopted"]);
  assert.equal(kids.I8021.label, "Ben Quill, adopted son, born 1981");
  assert.deepEqual(kids.I8022.badges, ["step"]);
  assert.deepEqual(kids.I8024.badges, ["foster"]);
  assert.equal(kids.I8024.label, "Dot Fosterly, foster daughter, born 1985");
  for (const id of ["I8025", "I8026", "I8027", "I8028"]) assert.deepEqual(kids[id].badges, [], id); // sponsored, none, custom, unknown
  const parents = navigatorModel(g, "I8001").parents.cards;
  assert.deepEqual(parents.map((c) => c.badges), [[], ["adopted"]]);
  assert.equal(parents[1].label, "Tess Marlow, adopted mother, about 1928 to unknown");
});

test("every card's accessible name is 'name, role, years'", () => {
  const m = navigatorModel(g, "I8001");
  const cards = [...m.parents.cards, ...m.unions.flatMap((u) => [u.partner, ...u.children].filter(Boolean)), ...m.siblings];
  assert.ok(cards.length >= 10);
  for (const c of cards) assert.equal(c.label.split(", ").length >= 3, true, c.label);
  assert.equal(m.parents.cards[0].label, "Sam Quill, father, 1925 to 1990");
});

test("siblings: full, half (with a 'half-' badge and word), and a parentless sibling group", () => {
  const s = navigatorModel(g, "I8001").siblings;
  assert.deepEqual(ids(s), ["I8004", "I8005"]);
  assert.deepEqual(s.map((c) => c.badges), [[], ["half-sibling"]]);
  assert.equal(s[1].label, "Kit Quill, half-sister, 1955 to 2001");
  // the group with no recorded parent at all, and the one whose only parent is private-excluded
  assert.deepEqual(ids(navigatorModel(g, "I8040").siblings), ["I8041", "I8042"]);
  assert.deepEqual(ids(navigatorModel(g, "I8043").siblings), ["I8044"]);
  assert.equal(navigatorModel(g, "I8040").parents.message, COPY.parentsNone);
});

test("a singleton is its own component at generation 0 and is 'not yet connected to the tree', with no relative-generation label", () => {
  assert.equal(g.person("I8050").generation, 0);
  assert.equal(g.person("I8050").component, 5);
  const m = navigatorModel(g, "I8050");
  assert.equal(m.connected, false);
  assert.equal(m.notice, "not yet connected to the tree");
  assert.equal(m.parents.message, "parents not recorded yet");
  assert.deepEqual(m.unions, []);
  assert.deepEqual(m.siblings, []);
  assert.ok(!JSON.stringify(m).includes("generation"), "no generation label");
  // a person with no generation at all (an ancestor cycle in the data) is not connected either
  assert.equal(navigatorModel(g, "I8051").connected, false);
  // and an ordinary person is connected
  assert.equal(navigatorModel(g, "I8001").connected, true);
});

test("detailsModel: years, places, unions, children and the page link", () => {
  const d = detailsModel(g, "I8001");
  assert.equal(d.years, "1952 to 2020");
  assert.equal(d.born, "Riverton, Marlow County, Examplestate");
  assert.equal(d.died, null);
  assert.deepEqual(d.parents.map((p) => [p.id, p.label]), [["I8002", "father"], ["I8003", "adopted mother"]]);
  assert.deepEqual(d.unions.map((u) => u.title), ["with Uma Vale", "with Vic Rowe", "partner not recorded", "partner not recorded"]);
  assert.deepEqual(d.unions[0].children.map((c) => [c.id, c.label]), [["I8020", "daughter"], ["I8021", "adopted son"]]);
  assert.equal(d.childCount, 9);
  assert.equal(d.href, "/person/?id=I8001");
  // a living person has no places
  assert.equal(detailsModel(g, "I8020").born, null);
});

test("a union without a partners array (older schema, hand-built data) does not take the cards view down", () => {
  // FamilyGraph itself rejects such a union, so this uses a minimal duck-typed graph: the model must still not throw.
  const people = new Map([["N1", { id: "N1", name: "Nia Test", generation: 0 }], ["N2", { id: "N2", name: "Noa Test", generation: 0 }]]);
  const loose = {
    data: { places: [], unions: [{ id: "UN1", children: [{ id: "N1" }, { id: "N2" }] }] },
    person: (id) => people.get(id) || null,
    has: (id) => people.has(id),
    parents: () => [],
    unionsOf: () => [],
    siblings: () => []
  };
  const m = navigatorModel(loose, "N1");
  assert.deepEqual(m.siblings.map((c) => c.id), ["N2"]);
});
