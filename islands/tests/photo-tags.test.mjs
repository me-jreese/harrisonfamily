// HFY-TSK-169 (HFY-PLN-002 surfaces 8): the pure part of the photo tags island (src/lib/photo-tags.js): the contained-image geometry in
// a 4:5 contain box for portrait, landscape and square images, rect normalisation and words, the site's role reading, label stacking
// and the cleaning of mediaGallery[].tags[]. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DENSE_ABOVE, ROLE_PHRASE, ROLES, areaWords, attributeLine, containedRect, normalizeRect, personHref, readingOrder, regionBox,
  regionLabel, roleOf, stackLabels, tagView, tagsOf
} from "../src/lib/photo-tags.js";

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ""} ${a} != ${b}`);
const rectIs = (r, x, y, w, h) => { close(r.x, x, "x"); close(r.y, y, "y"); close(r.w, w, "w"); close(r.h, h, "h"); };

// the gallery box: 320 wide and 4:5, so 400 tall
test("containedRect: a landscape image in a 4:5 contain box is full width, centred vertically", () => {
  rectIs(containedRect(320, 400, 800, 600), 0, 80, 320, 240);
});
test("containedRect: a portrait image in a 4:5 contain box is full height, centred horizontally", () => {
  rectIs(containedRect(320, 400, 600, 900), (320 - 400 * (600 / 900)) / 2, 0, 400 * (600 / 900), 400);
});
test("containedRect: a square image in a 4:5 contain box is full width, centred vertically", () => {
  rectIs(containedRect(320, 400, 700, 700), 0, 40, 320, 320);
});
test("containedRect: an image with the box's own ratio fills it; the image is never scaled up past the box", () => {
  rectIs(containedRect(320, 400, 640, 800), 0, 0, 320, 400);
  rectIs(containedRect(343, 428.75, 10, 10), 0, (428.75 - 343) / 2, 343, 343);
});
test("containedRect: s = min(boxW/natW, boxH/natH) for any box; cover and fill; a missing size falls back to the box", () => {
  for (const [bw, bh, nw, nh] of [[375, 469, 4000, 3000], [100, 250, 30, 90], [90, 90, 1, 7]]) {
    const r = containedRect(bw, bh, nw, nh);
    const s = Math.min(bw / nw, bh / nh);
    rectIs(r, (bw - nw * s) / 2, (bh - nh * s) / 2, nw * s, nh * s);
  }
  rectIs(containedRect(320, 400, 800, 600, "cover"), (320 - 800 * (400 / 600)) / 2, 0, 800 * (400 / 600), 400);
  rectIs(containedRect(320, 400, 800, 600, "fill"), 0, 0, 320, 400);
  rectIs(containedRect(320, 400, 0, 0), 0, 0, 320, 400);
  rectIs(containedRect(NaN, 400, 8, 6), 0, 0, 0, 400);
});

test("normalizeRect: corners are ordered and held in 0..100; no area is null", () => {
  assert.deepEqual(normalizeRect([12, 8, 32, 33]), [12, 8, 32, 33]);
  assert.deepEqual(normalizeRect([32, 33, 12, 8]), [12, 8, 32, 33]);
  assert.deepEqual(normalizeRect([-5, 10, 130, 90]), [0, 10, 100, 90]);
  for (const bad of [null, undefined, [], [1, 2, 3], [1, 2, 3, 4, 5], ["1", 2, 3, 4], [10, 10, 10, 40], [10, 10, 40, 10], [NaN, 1, 2, 3], "x", { 0: 1 }]) {
    assert.equal(normalizeRect(bad), null, JSON.stringify(bad));
  }
});

test("regionBox: the rect in pixels on the contained image", () => {
  const b = regionBox([10, 20, 50, 60], { x: 0, y: 80, w: 320, h: 240 });
  close(b.left, 32); close(b.top, 80 + 48); close(b.width, 128); close(b.height, 96);
  const c = regionBox([0, 0, 100, 100], { x: 26.5, y: 0, w: 267, h: 400 });
  close(c.left, 26.5); close(c.top, 0); close(c.width, 267); close(c.height, 400);
});

test("areaWords: where, then the numbers; a missing rect is 'no area marked'", () => {
  assert.equal(areaWords([12, 8, 32, 33]), "upper left · 12% from the left, 8% from the top, 20% wide, 25% tall");
  assert.equal(areaWords([40, 40, 60, 60]), "center · 40% from the left, 40% from the top, 20% wide, 20% tall");
  assert.equal(areaWords([80, 40, 95, 60]), "right · 80% from the left, 40% from the top, 15% wide, 20% tall");
  assert.equal(areaWords([40, 75, 60, 95]), "lower · 40% from the left, 75% from the top, 20% wide, 20% tall");
  assert.equal(areaWords([0, 0, 100, 100]), "center · 0% from the left, 0% from the top, 100% wide, 100% tall");
  assert.equal(areaWords(null), "no area marked");
});

const PERSON = {
  grampsId: "I1",
  familyTree: {
    parentFamilies: [{
      father: { grampsId: "I2", parentFamilies: [{ father: { grampsId: "I8" }, mother: { grampsId: "I9" } }] },
      mother: { grampsId: "I3" },
      children: [{ grampsId: "I1" }, { grampsId: "I4" }]
    }],
    spouseFamilies: [{
      father: { grampsId: "I1" }, mother: { grampsId: "I5" },
      children: [{ grampsId: "I6", spouseFamilies: [{ children: [{ grampsId: "I7" }] }] }]
    }]
  }
};
test("roleOf: the site's reading of the page's tree, in the DS vocabulary", () => {
  const got = Object.fromEntries(["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9", "I99"].map((id) => [id, roleOf(PERSON, id)]));
  assert.deepEqual(got, { I1: "focus", I2: "parent", I3: "parent", I4: "sibling", I5: "spouse", I6: "child", I7: "grandchild", I8: "grandparent", I9: "grandparent", I99: "family" });
  assert.equal(roleOf(PERSON, null), "family");
  assert.equal(roleOf(null, "I1"), "family");
  assert.equal(roleOf({ grampsId: "I1" }, "I2"), "family");
  for (const r of Object.values(got)) assert.ok(ROLES.includes(r));
  for (const r of ROLES) assert.ok(ROLE_PHRASE[r]);
});

test("tagView: the Gramps tag data, cleaned; the relationship is separate", () => {
  const v = tagView({
    grampsId: "I4", name: "  Sib Example ", rect: [30, 20, 10, 5], isPrimary: true, source: "site",
    attributes: [{ type: "Age", value: 12 }, { type: "", value: "" }, null, { type: "Label" }],
    notes: ["  a note ", "", { text: "second" }, null], citations: ["Title A", { title: "Title B" }, {}]
  }, PERSON);
  assert.deepEqual(v, {
    grampsId: "I4", name: "Sib Example", rect: [10, 5, 30, 20], isPrimary: true,
    attributes: [{ type: "Age", value: "12" }, { type: "Label", value: "" }], notes: ["a note", "second"], citations: ["Title A", "Title B"],
    source: "site", role: "sibling", area: "upper left · 10% from the left, 5% from the top, 20% wide, 15% tall"
  });
  assert.equal(attributeLine({ type: "Age", value: "12" }), "Age: 12");
  assert.equal(attributeLine({ type: "Label", value: "" }), "Label");
  assert.equal(personHref(v), "/person/?id=I4");
  assert.equal(regionLabel(v), "Sib Example, sibling. open their page");
  assert.equal(regionLabel({ ...v, role: "focus" }), "Sib Example, this person. open their page");
});

test("tagView: a tag without a name or an id is dropped; a null rect has no area; defaults are safe", () => {
  assert.equal(tagView({ rect: [1, 2, 3, 4] }, PERSON), null);
  assert.equal(tagView(null, PERSON), null);
  assert.equal(tagView("x", PERSON), null);
  const v = tagView({ grampsId: "I99", rect: null }, PERSON);
  assert.equal(v.name, "someone");
  assert.equal(v.rect, null);
  assert.equal(v.area, "no area marked");
  assert.deepEqual([v.attributes, v.notes, v.citations, v.isPrimary, v.source], [[], [], [], false, "gramps"]);
  assert.equal(personHref({ grampsId: null }), null);
});

test("tagView: text stays text. Markup in a name, note or attribute comes back as the same string, never parsed or stripped", () => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  const v = tagView({ grampsId: "I4", name: evil, rect: [1, 1, 9, 9], attributes: [{ type: evil, value: evil }], notes: [evil], citations: [evil] }, PERSON);
  assert.equal(v.name, evil);
  assert.deepEqual(v.attributes, [{ type: evil, value: evil }]);
  assert.deepEqual([v.notes, v.citations], [[evil], [evil]]);
});

test("tagsOf: the tags of one photo; none for a photo without tags or a malformed one", () => {
  assert.equal(tagsOf({ tags: [{ grampsId: "I1" }, null, { grampsId: "I2", name: "B" }] }, PERSON).length, 2);
  for (const m of [null, {}, { tags: null }, { tags: "x" }, { tags: [] }]) assert.deepEqual(tagsOf(m, PERSON), []);
});

test("readingOrder: tags with an area, top to bottom and then left to right", () => {
  const views = [
    { rect: [50, 50, 60, 60] }, { rect: null }, { rect: [10, 10, 20, 20] }, { rect: [60, 10, 70, 20] }, { rect: [10, 10, 15, 30] }
  ];
  assert.deepEqual(readingOrder(views), [2, 4, 3, 0]);
});

test("stackLabels: under the region, flipped above near the bottom, clamped inside, colliding labels moved by the overlap", () => {
  const bounds = { w: 300, h: 200 };
  const [a] = stackLabels([{ x: 10, y: 10, w: 40, h: 40, lw: 60, lh: 20 }], bounds);
  assert.deepEqual(a, { left: 10, top: 50 });
  const [b] = stackLabels([{ x: 250, y: 170, w: 40, h: 25, lw: 60, lh: 20 }], bounds);
  assert.deepEqual(b, { left: 240, top: 150 }); // flipped above, clamped to the right edge
  const [c] = stackLabels([{ x: -5, y: 0, w: 10, h: 10, lw: 400, lh: 20 }], bounds);
  assert.equal(c.left, 0);
  const [p, q, r] = stackLabels([
    { x: 10, y: 10, w: 40, h: 40, lw: 60, lh: 20 },
    { x: 20, y: 10, w: 40, h: 40, lw: 60, lh: 20 },
    { x: 30, y: 10, w: 40, h: 40, lw: 60, lh: 20 }
  ], bounds, 2);
  assert.deepEqual([p.top, q.top, r.top], [50, 72, 94]);
  const noOverlap = [p, q, r].every((s, i, all) => all.every((t, j) => i === j || s.top + 20 <= t.top || t.top + 20 <= s.top));
  assert.ok(noOverlap);
  // above the bottom edge the stack grows upward
  const [u, v] = stackLabels([
    { x: 10, y: 180, w: 40, h: 15, lw: 60, lh: 20 },
    { x: 20, y: 180, w: 40, h: 15, lw: 60, lh: 20 }
  ], bounds);
  assert.deepEqual([u.top, v.top], [160, 140]);
});

test("the dense limit is 12", () => assert.equal(DENSE_ABOVE, 12));
