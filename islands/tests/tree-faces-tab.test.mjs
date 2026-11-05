// HFY-TSK-308 (viz-v2-faces-tab): the faces tab's pure model (lib/faces-model.js) in node, on the synthetic tests/fixtures/tree-graph-small.json
// (invented names) with synthetic photoEdges. A null face stays null (initials); nothing is guessed from a region.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseGraph } from "../src/lib/family-graph.js";
import { FIRST_VIEW_FACES, facePeople, facesGroups, firstViewCount, galleryItem, mediaOf, photoSrc } from "../src/lib/faces-model.js";
import { normalizeView } from "../src/lib/tree-view.js";

const base = JSON.parse(readFileSync(new URL("./fixtures/tree-graph-small.json", import.meta.url), "utf8"));
const graph = (photoEdges, faces = {}) => parseGraph({ ...base, photoEdges, people: base.people.map((p) => (faces[p.id] ? { ...p, face: faces[p.id] } : p)) });

test("one group per photoEdges entry, in order; unknown people, repeats and malformed entries are skipped", () => {
  const g = graph([
    { media: "O1", people: ["I9003", "I9004", "I9003", "I9999"] },
    { media: "O1", people: ["I9001"] },
    { media: "O2" },
    null,
    { media: "O3", people: ["I9999"] },
    { media: "O4", people: ["I9002"] }
  ]);
  const groups = facesGroups(g);
  assert.deepEqual(groups.map((x) => [x.media, x.index, x.people.map((p) => p.id)]), [["O1", 1, ["I9003", "I9004"]], ["O4", 2, ["I9002"]]]);
  assert.deepEqual(facesGroups(parseGraph(base)), []);
});

test("a face is a served URL only for the builder's own file name; null stays null with initials", () => {
  const g = graph([{ media: "O1", people: ["I9003", "I9004", "I9002"] }], { I9003: "faces/I9003-0123abcd.webp", I9004: "../../etc/passwd" });
  const [grp] = facesGroups(g);
  const by = Object.fromEntries(grp.people.map((p) => [p.id, p]));
  assert.equal(by.I9003.face, "/media/faces/I9003-0123abcd.webp");
  assert.equal(by.I9004.face, null);
  assert.equal(by.I9002.face, null);
  assert.equal(by.I9002.initials, "HS");
});

test("mediaOf lists the photos a person is in; facePeople lists everyone once by name", () => {
  const groups = facesGroups(graph([{ media: "O1", people: ["I9003", "I9004"] }, { media: "O2", people: ["I9004", "I9002"] }]));
  assert.deepEqual([...mediaOf(groups, "I9004")], ["O1", "O2"]);
  assert.deepEqual([...mediaOf(groups, "I9002")], ["O2"]);
  assert.deepEqual([...mediaOf(groups, "I9001")], []);
  assert.deepEqual(facePeople(groups).map((p) => p.id), ["I9003", "I9004", "I9002"]);
});

test("the first view holds at most 24 faces, and always at least one photo", () => {
  const mk = (n) => ({ people: Array.from({ length: n }, (_, i) => ({ id: `I${i}` })) });
  assert.equal(firstViewCount([mk(10), mk(10), mk(10)]), 2);
  assert.equal(firstViewCount([mk(30), mk(2)]), 1);
  assert.equal(firstViewCount([]), 0);
  assert.equal(FIRST_VIEW_FACES, 24);
});

test("a gallery item is found by its Gramps media id, and its image URL follows the person page's rule", () => {
  const person = { mediaGallery: [{ handle: "MA", mime: "image/png", grampsId: "O1" }, { handle: "MB", grampsId: "O2" }, { handle: "MC", grampsId: "O3", s3Key: "uploads/x/MC.webp" }, { handle: "../x", grampsId: "O4" }] };
  assert.equal(photoSrc(galleryItem(person, "O1")), "/media/MA.png");
  assert.equal(photoSrc(galleryItem(person, "O2")), "/media/MB.jpg");
  assert.equal(photoSrc(galleryItem(person, "O3")), "/media/MC.webp");
  assert.equal(photoSrc(galleryItem(person, "O4")), null);
  assert.equal(galleryItem(person, "O9"), null);
  assert.equal(galleryItem(null, "O1"), null);
});

test("?view=faces is a known view", () => {
  assert.equal(normalizeView("faces"), "faces");
});
