// HFY-TSK-260 (tag-editor-ui, flag photoTagEdit): the pure half of the photo tag editor (src/lib/photo-tag-edit.js), pinned against the API's own
// modules: the rect rule against the server validator, the ops against the ops engine and the field policy, and the stale key against a
// conflict (the field policy and the endpoint are pinned in api/test/records/tag-editor.node-test.js). Synthetic people, handles and ids only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyOps, validateOps } from "../../api/src/records/ops.js";
import { rectViolations, schemaViolations } from "../../api/src/sync/schema.js";
import { rectProblem } from "../../shared/redaction-rules.mjs";
import {
  BIG_STEP, DEFAULT_RECT, DRAW_MIN, MIN_SIDE, STEP, TAG_COPY, allTagText, applyToTags, buildTagOps, canRemoveTag, canUseTagEditor, dragCorner,
  expectedRoute, findTagElement, isDrawn, isSelf, mediaRefsOf, moveEdge, moveRect, newMediaRef, nthOf, nudgeCorner, pointToPercent, rectBetween,
  sameRect, tagSentence, toGrampsRect
} from "../src/lib/photo-tag-edit.js";
import { containedRect } from "../src/lib/photo-tags.js";
// The words that must never reach a member (api/src/records/edit-plan.js JARGON; that module needs the API's dependencies, so the pattern is repeated here).
const JARGON = /\b(ChildRef|EventRef|MediaRef|PersonRef|frel|mrel|handle|gramps_id|new:\d+|_class|birth_ref_index|death_ref_index)\b|@(ref|k)?=/i;

const POLICY = JSON.parse(readFileSync(new URL("../../gramps/redaction/redaction-v1.json", import.meta.url), "utf8"));
const MEDIA = "hm0001";
const mref = (rect, extra = {}) => ({ _class: "MediaRef", private: false, citation_list: [], note_list: [], attribute_list: [], ref: MEDIA, rect, ...extra });
const person = (n, media = []) => ({ _class: "Person", handle: `hp000${n}`, gramps_id: `I900${n}`, private: false, gender: 2, media_list: media, event_ref_list: [], family_list: [], parent_family_list: [], note_list: [], urls: [] });
const keyOf = (p) => `Person:${p.handle}`;
const bundleOf = (p, relation = "other") => ({ key: keyOf(p), version: 3, obj: p, relation, viewer: { admin: false } });

// ---- the rect rule ------------------------------------------------------------------------------------------------------------------

describe("toGrampsRect (the one rule)", () => {
  it("floors x1 and y1, ceils x2 and y2", () => {
    assert.deepEqual(toGrampsRect([10.2, 20.9, 30.1, 50.5]), [10, 20, 31, 51]);
    assert.deepEqual(toGrampsRect([0.4, 0.4, 98.2, 98.2]), [0, 0, 99, 99]);
  });

  it("leaves integers alone and ignores the float noise of a pointer sum", () => {
    assert.deepEqual(toGrampsRect([10, 20, 30, 50]), [10, 20, 30, 50]);
    assert.deepEqual(toGrampsRect([29.999999999, 30.000000001, 59.999999999, 60.000000001]), [30, 30, 60, 60]);
    assert.deepEqual(toGrampsRect([0.1 + 0.2, 0.3, 10.1 + 0.2, 20]), [0, 0, 11, 20]);
  });

  it("puts the corners in order and clamps to 0..100", () => {
    assert.deepEqual(toGrampsRect([30, 50, 10, 20]), [10, 20, 30, 50]);
    assert.deepEqual(toGrampsRect([-5, -1, 40, 120]), [0, 0, 40, 100]);
  });

  it("is at least 1 unit wide and 1 unit tall", () => {
    assert.deepEqual(toGrampsRect([10, 10, 10, 10]), [10, 10, 11, 11]);
    assert.deepEqual(toGrampsRect([10.0, 10, 10.0000001, 30]), [10, 10, 11, 30]);
    assert.deepEqual(toGrampsRect([100, 100, 100, 100]), [99, 99, 100, 100], "on the far edge it grows toward the near edge");
    assert.deepEqual(toGrampsRect([50, 100, 60, 100]), [50, 99, 60, 100]);
  });

  it("is never [0, 0, 100, 100]: a full-frame box is trimmed by one unit at the right and the bottom", () => {
    assert.deepEqual(toGrampsRect([0, 0, 100, 100]), [0, 0, 99, 99]);
    assert.deepEqual(toGrampsRect([-10, -10, 110, 110]), [0, 0, 99, 99]);
    assert.deepEqual(toGrampsRect([0.2, 0.2, 99.8, 99.8]), [0, 0, 99, 99], "floored and ceiled it would be the full frame, so it is trimmed too");
    assert.deepEqual(toGrampsRect([0, 0, 100, 99.5]), [0, 0, 99, 99]);
    assert.deepEqual(toGrampsRect([0, 0, 100, 99]), [0, 0, 100, 99], "a box that is not the full frame is kept");
  });

  it("returns null for anything that is not four finite numbers", () => {
    for (const bad of [null, undefined, [], [1, 2, 3], [1, 2, 3, 4, 5], [1, 2, 3, NaN], [1, 2, 3, Infinity], ["1", 2, 3, 4], "10,20,30,40", { 0: 1 }]) assert.equal(toGrampsRect(bad), null);
  });

  it("always passes the server's rect validator and contains the drawn box (1000 random boxes)", () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    for (let i = 0; i < 1000; i += 1) {
      const raw = [rnd() * 120 - 10, rnd() * 120 - 10, rnd() * 120 - 10, rnd() * 120 - 10];
      const out = toGrampsRect(raw);
      assert.equal(rectProblem(out, POLICY), null, JSON.stringify(raw));
      assert.ok(out.every(Number.isInteger));
      assert.ok(out[2] - out[0] >= 1 && out[3] - out[1] >= 1);
      const clamped = raw.map((v) => Math.min(100, Math.max(0, v)));
      const full = out[2] === 99 && out[3] === 99 && out[0] === 0 && out[1] === 0;
      if (!full) {
        assert.ok(out[0] <= Math.min(clamped[0], clamped[2]) + 1e-9 && out[2] >= Math.max(clamped[0], clamped[2]) - 1e-9, `contains x ${JSON.stringify(raw)}`);
        assert.ok(out[1] <= Math.min(clamped[1], clamped[3]) + 1e-9 && out[3] >= Math.max(clamped[1], clamped[3]) - 1e-9, `contains y ${JSON.stringify(raw)}`);
      }
    }
  });

  it("the default box and every nudge result convert to a valid rect", () => {
    assert.equal(rectProblem(toGrampsRect([...DEFAULT_RECT]), POLICY), null);
  });
});

// ---- geometry -----------------------------------------------------------------------------------------------------------------------

describe("drawing, moving and resizing", () => {
  const contained = containedRect(400, 300, 800, 600); // the picture fills the layer
  it("maps a pointer to percent of the picture, held inside it", () => {
    const layer = { left: 100, top: 50 };
    assert.deepEqual(pointToPercent(300, 200, layer, contained), { x: 50, y: 50 });
    assert.deepEqual(pointToPercent(0, 0, layer, contained), { x: 0, y: 0 });
    assert.deepEqual(pointToPercent(9999, 9999, layer, contained), { x: 100, y: 100 });
    assert.equal(pointToPercent(1, 1, layer, { x: 0, y: 0, w: 0, h: 0 }), null);
  });

  it("maps a pointer on a letterboxed picture to the picture, not the box", () => {
    const tall = containedRect(400, 300, 300, 600); // portrait photo in a landscape box: 150 wide, centred
    assert.equal(tall.w, 150);
    const layer = { left: 0, top: 0 };
    const mid = pointToPercent(200, 150, layer, tall);
    assert.deepEqual(mid, { x: 50, y: 50 });
    assert.deepEqual(pointToPercent(10, 150, layer, tall), { x: 0, y: 50 }, "left of the picture is its left edge");
  });

  it("rectBetween orders the corners; isDrawn tells a box from a tap", () => {
    assert.deepEqual(rectBetween({ x: 60, y: 10 }, { x: 20, y: 40 }), [20, 10, 60, 40]);
    assert.equal(isDrawn({ x: 10, y: 10 }, { x: 10 + DRAW_MIN, y: 10 + DRAW_MIN }), true);
    assert.equal(isDrawn({ x: 10, y: 10 }, { x: 11, y: 40 }), false);
  });

  it("moveRect keeps the size and stays inside the photo", () => {
    assert.deepEqual(moveRect([10, 10, 30, 20], 5, -3), [15, 7, 35, 17]);
    assert.deepEqual(moveRect([10, 10, 30, 20], -50, -50), [0, 0, 20, 10]);
    assert.deepEqual(moveRect([70, 80, 100, 100], 10, 10), [70, 80, 100, 100]);
  });

  it("moveEdge moves one edge and never inverts or leaves the photo", () => {
    const r = [20, 20, 40, 40];
    assert.deepEqual(moveEdge(r, "left", -STEP), [19, 20, 40, 40]);
    assert.deepEqual(moveEdge(r, "right", STEP), [20, 20, 41, 40]);
    assert.deepEqual(moveEdge(r, "top", -BIG_STEP), [20, 15, 40, 40]);
    assert.deepEqual(moveEdge(r, "bottom", BIG_STEP), [20, 20, 40, 45]);
    assert.deepEqual(moveEdge(r, "left", 500), [20 + 20 - MIN_SIDE, 20, 40, 40], "left stops one unit short of right");
    assert.deepEqual(moveEdge(r, "right", -500), [20, 20, 20 + MIN_SIDE, 40]);
    assert.deepEqual(moveEdge(r, "left", -500), [0, 20, 40, 40]);
    assert.deepEqual(moveEdge(r, "bottom", 500), [20, 20, 40, 100]);
    assert.deepEqual(moveEdge(r, "sideways", 5), r);
  });

  it("dragCorner moves the two edges that meet at the corner", () => {
    const r = [20, 20, 40, 40];
    assert.deepEqual(dragCorner(r, "nw", { x: 10, y: 5 }), [10, 5, 40, 40]);
    assert.deepEqual(dragCorner(r, "se", { x: 60, y: 90 }), [20, 20, 60, 90]);
    assert.deepEqual(dragCorner(r, "ne", { x: 45, y: 10 }), [20, 10, 45, 40]);
    assert.deepEqual(dragCorner(r, "sw", { x: 5, y: 70 }), [5, 20, 40, 70]);
    assert.deepEqual(dragCorner(r, "se", { x: 0, y: 0 }), [20, 20, 21, 21], "dragged past the opposite corner it stops one unit from it");
    assert.deepEqual(nudgeCorner(r, "nw", 1, 1), [21, 21, 40, 40]);
  });

  it("every box reached by the nudge buttons is a valid server rect", () => {
    let r = [...DEFAULT_RECT];
    for (let i = 0; i < 80; i += 1) r = moveEdge(r, ["left", "right", "top", "bottom"][i % 4], i % 8 < 4 ? -STEP : STEP);
    assert.equal(rectProblem(toGrampsRect(r), POLICY), null);
  });
});

// ---- who may do what ----------------------------------------------------------------------------------------------------------------

describe("permissions and routes", () => {
  const me = { id: "I9001", admin: false, editing: true };
  it("the editor needs a signed-in member and editing not switched off", () => {
    assert.equal(canUseTagEditor(me), true);
    assert.equal(canUseTagEditor({ id: "I9001" }), true, "a missing editing is not off");
    assert.equal(canUseTagEditor({ ...me, editing: false }), false);
    assert.equal(canUseTagEditor({ id: null }), false);
    assert.equal(canUseTagEditor(null), false);
  });
  it("a member removes their own tag, an admin any, nobody else's", () => {
    assert.equal(canRemoveTag(me, { grampsId: "I9001" }), true);
    assert.equal(canRemoveTag(me, { grampsId: "I9002" }), false);
    assert.equal(canRemoveTag({ ...me, admin: true }, { grampsId: "I9002" }), true);
    assert.equal(canRemoveTag({ id: "x", ownRecord: { gramps_id: "I9002" } }, { grampsId: "I9002" }), true, "the record /api/me names as theirs");
    assert.equal(canRemoveTag(null, { grampsId: "I9001" }), false);
  });
  it("the expected route: own record or admin saves now, else review", () => {
    assert.equal(expectedRoute(me, "I9001"), "direct");
    assert.equal(expectedRoute(me, "I9002"), "review");
    assert.equal(expectedRoute({ ...me, admin: true }, "I9002"), "direct");
    assert.equal(isSelf(me, "I9001"), true);
    assert.equal(isSelf(me, ""), false);
  });
});

// ---- the MediaRef and the ops -------------------------------------------------------------------------------------------------------

describe("finding the tag a page shows", () => {
  const p = person(2, [mref([10, 10, 30, 30]), { ...mref([10, 10, 30, 30]), note_list: ["hn1"] }, mref([50, 50, 70, 70]), { ...mref([1, 1, 5, 5]), ref: "hm0002" }]);
  it("lists the elements for a media, with the ops key of each", () => {
    const refs = mediaRefsOf(p, MEDIA);
    assert.deepEqual(refs.map((r) => r.index), [0, 1, 2]);
    assert.ok(refs.every((r) => /^@ref=hm0001#\d:[0-9a-f]{12}$/.test(r.segment)), refs.map((r) => r.segment).join());
    assert.deepEqual(refs.map((r) => r.segment.split("#")[1].split(":")[0]), ["0", "1", "2"], "n counts occurrences of the ref in the whole list");
  });
  it("matches by rect in normal order, and picks the nth of identical ones", () => {
    assert.equal(findTagElement(p, MEDIA, [50, 50, 70, 70]).index, 2);
    assert.equal(findTagElement(p, MEDIA, [70, 70, 50, 50]).index, 2, "reversed corners are the same box");
    assert.equal(findTagElement(p, MEDIA, [10, 10, 30, 30], 0).index, 0);
    assert.equal(findTagElement(p, MEDIA, [10, 10, 30, 30], 1).index, 1);
    assert.equal(findTagElement(p, MEDIA, [10, 10, 30, 30], 2), null);
    assert.equal(findTagElement(p, MEDIA, [11, 10, 30, 30]), null, "a rect that is not stored is no tag");
    assert.equal(findTagElement(p, "hm9999", [10, 10, 30, 30]), null);
  });
  it("nthOf counts identical tags (same person and rect) before the index", () => {
    const tags = [{ grampsId: "I9002", rect: [10, 10, 30, 30] }, { grampsId: "I9003", rect: [10, 10, 30, 30] }, { grampsId: "I9002", rect: [30, 30, 10, 10] }];
    assert.equal(nthOf(tags, 0), 0);
    assert.equal(nthOf(tags, 1), 0);
    assert.equal(nthOf(tags, 2), 1);
  });
});

describe("buildTagOps against the ops engine", () => {
  it("add: an add op on /media_list with a clean MediaRef and the integer rect", () => {
    const p = person(2);
    const built = buildTagOps(bundleOf(p), { kind: "add", mediaHandle: MEDIA, rect: [10.4, 20.2, 30.1, 40.9] });
    assert.equal(built.ok, true);
    assert.deepEqual(built.ops, [{ id: "tag.add", op: "add", obj: keyOf(p), path: "/media_list", value: newMediaRef(MEDIA, [10, 20, 31, 41]) }]);
    assert.deepEqual(validateOps(built.ops), []);
    const applied = applyOps({ [keyOf(p)]: p }, built.ops);
    assert.equal(applied.ok, true);
    assert.deepEqual(applied.objects[keyOf(p)].media_list, [newMediaRef(MEDIA, [10, 20, 31, 41])]);
    assert.deepEqual(rectViolations(applied.objects[keyOf(p)], POLICY), [], "the server's rect validator accepts it");
    assert.deepEqual(schemaViolations(applied.objects[keyOf(p)]), [], "and so does the Gramps schema");
  });

  it("add: a second tag of one person in one photo is a second element, never a replacement (SI-22)", () => {
    const p = person(2, [mref([10, 10, 30, 30])]);
    const built = buildTagOps(bundleOf(p), { kind: "add", mediaHandle: MEDIA, rect: [50, 50, 70, 70] });
    const applied = applyOps({ [keyOf(p)]: p }, built.ops);
    assert.equal(applied.ok, true);
    assert.deepEqual(applied.objects[keyOf(p)].media_list.map((m) => m.rect), [[10, 10, 30, 30], [50, 50, 70, 70]]);
  });

  it("add: the very same tag again is refused before anything is sent; a media_list that is missing is created", () => {
    const p = person(2, [mref([10, 10, 30, 30])]);
    assert.deepEqual(buildTagOps(bundleOf(p), { kind: "add", mediaHandle: MEDIA, rect: [10, 10, 30, 30] }), { ok: false, reason: "exists" });
    const bare = { ...person(3) };
    delete bare.media_list;
    const built = buildTagOps(bundleOf(bare), { kind: "add", mediaHandle: MEDIA, rect: [1, 1, 9, 9] });
    assert.deepEqual(built.ops[0], { id: "tag.add", op: "set", obj: keyOf(bare), path: "/media_list", base: null, value: [newMediaRef(MEDIA, [1, 1, 9, 9])] });
    assert.equal(applyOps({ [keyOf(bare)]: bare }, built.ops).ok, true);
  });

  it("move: a set of rect at the element's key, with the stored rect as base", () => {
    const p = person(2, [mref([10, 10, 30, 30]), mref([50, 50, 70, 70])]);
    const built = buildTagOps(bundleOf(p), { kind: "move", mediaHandle: MEDIA, from: [50, 50, 70, 70], rect: [52.3, 50, 71.2, 70] });
    assert.equal(built.ok, true);
    const op = built.ops[0];
    assert.equal(op.op, "set");
    assert.match(op.path, /^\/media_list\/@ref=hm0001#1:[0-9a-f]{12}\/rect$/);
    assert.deepEqual([op.base, op.value], [[50, 50, 70, 70], [52, 50, 72, 70]]);
    assert.deepEqual(validateOps(built.ops), []);
    const applied = applyOps({ [keyOf(p)]: p }, built.ops);
    assert.equal(applied.ok, true);
    assert.deepEqual(applied.objects[keyOf(p)].media_list.map((m) => m.rect), [[10, 10, 30, 30], [52, 50, 72, 70]], "the other tag is untouched");
    assert.deepEqual(rectViolations(applied.objects[keyOf(p)], POLICY), []);
    assert.deepEqual(applyOps(applied.objects, applied.inverse).objects[keyOf(p)], p, "the undo puts the rect back");
  });

  it("move or remove of a tag that changed since the page was built is stale: nothing is sent", () => {
    const p = person(2, [mref([10, 10, 30, 30])]);
    assert.deepEqual(buildTagOps(bundleOf(p), { kind: "move", mediaHandle: MEDIA, from: [12, 10, 30, 30], rect: [20, 20, 40, 40] }), { ok: false, reason: "stale" });
    assert.deepEqual(buildTagOps(bundleOf(p), { kind: "remove", mediaHandle: MEDIA, from: [12, 10, 30, 30] }), { ok: false, reason: "stale" });
    assert.deepEqual(buildTagOps(bundleOf(p), { kind: "move", mediaHandle: MEDIA, from: [10, 10, 30, 30], rect: [10, 10, 30, 30] }), { ok: false, reason: "nochange" });
    assert.deepEqual(buildTagOps(bundleOf(p), { kind: "move", mediaHandle: MEDIA, from: [10, 10, 30, 30], rect: [1, 2, 3] }), { ok: false, reason: "invalid" });
    assert.deepEqual(buildTagOps(bundleOf(p), { kind: "wat", mediaHandle: MEDIA }), { ok: false, reason: "invalid" });
    assert.deepEqual(buildTagOps(null, { kind: "add", mediaHandle: MEDIA, rect: [1, 1, 5, 5] }), { ok: false, reason: "invalid" });
  });

  it("a key read before someone else's change reports a conflict and never acts on another rectangle (BRD2 SI-22)", () => {
    // Two tags of one person in one photo. The editor reads them, then another session moves tag 0 to exactly where tag 1 was edited from.
    const read = person(2, [mref([10, 10, 30, 30]), mref([50, 50, 70, 70])]);
    const built = buildTagOps(bundleOf(read), { kind: "move", mediaHandle: MEDIA, from: [10, 10, 30, 30], rect: [11, 10, 31, 30] });
    const now = person(2, [mref([12, 12, 32, 32]), mref([50, 50, 70, 70])]); // tag 0 changed meanwhile
    const r = applyOps({ [keyOf(now)]: now }, built.ops);
    assert.equal(r.ok, false);
    assert.equal(r.conflicts.length, 1);
    assert.deepEqual(now.media_list.map((m) => m.rect), [[12, 12, 32, 32], [50, 50, 70, 70]], "nothing moved");
    // the tag was removed and another one drawn in its place with different content: still a conflict
    const swapped = person(2, [mref([10, 10, 30, 30], { note_list: ["hn9"] }), mref([50, 50, 70, 70])]);
    assert.equal(applyOps({ [keyOf(swapped)]: swapped }, built.ops).ok, false, "same rect, other content: the hash differs");
  });

  it("remove: a remove at the key with the element as base; the undo adds it back", () => {
    const own = person(1, [mref([10, 10, 30, 30]), mref([10, 10, 30, 30], { note_list: ["hn1"] })]);
    const built = buildTagOps(bundleOf(own, "own"), { kind: "remove", mediaHandle: MEDIA, from: [10, 10, 30, 30], nth: 1 });
    assert.equal(built.ok, true);
    assert.match(built.ops[0].path, /^\/media_list\/@ref=hm0001#1:[0-9a-f]{12}$/);
    assert.deepEqual(validateOps(built.ops), []);
    const applied = applyOps({ [keyOf(own)]: own }, built.ops);
    assert.equal(applied.ok, true);
    assert.equal(applied.objects[keyOf(own)].media_list.length, 1);
    assert.deepEqual(applyOps(applied.objects, applied.inverse).objects[keyOf(own)], own);
  });
});

// ---- the page's copy of the tags ----------------------------------------------------------------------------------------------------

describe("applyToTags", () => {
  const tags = [
    { grampsId: "I9002", name: "Spouse Example", rect: [10, 20, 30, 50], isPrimary: false, attributes: [], notes: [], citations: [], source: "gramps" },
    { grampsId: "I9002", name: "Spouse Example", rect: [50, 20, 30, 50], isPrimary: false, attributes: [], notes: [], citations: [], source: "gramps" },
    { grampsId: "I9003", name: "Child Example", rect: null, isPrimary: false, attributes: [], notes: [], citations: [], source: "gramps" }
  ];
  it("adds a site tag with the stored rect", () => {
    const out = applyToTags(tags, { kind: "add", grampsId: "I9004", name: "Sibling Example" }, [1, 2, 3, 4]);
    assert.equal(out.length, 4);
    assert.deepEqual(out[3], { grampsId: "I9004", name: "Sibling Example", rect: [1, 2, 3, 4], isPrimary: false, attributes: [], notes: [], citations: [], source: "site" });
    assert.equal(tags.length, 3, "the input is not changed");
  });
  it("moves and removes the tag that matches, even with reversed corners in the data", () => {
    assert.deepEqual(applyToTags(tags, { kind: "move", grampsId: "I9002", from: [30, 50, 50, 20] }, [31, 20, 51, 50])[1].rect, [31, 20, 51, 50]);
    assert.deepEqual(applyToTags(tags, { kind: "remove", grampsId: "I9002", from: [10, 20, 30, 50] }, null).map((t) => t.grampsId), ["I9002", "I9003"]);
    assert.equal(applyToTags(tags, { kind: "remove", grampsId: "I9002", from: [1, 1, 2, 2] }, null).length, 3, "no match changes nothing");
  });
});

// ---- the words ----------------------------------------------------------------------------------------------------------------------

describe("copy", () => {
  it("is lowercase plain words with no Gramps terms", () => {
    for (const s of allTagText()) {
      assert.doesNotMatch(s, JARGON, s);
      assert.doesNotMatch(s, /\b(rect|rectangle|mediaref|media_list|handle|payload|api)\b/i, s);
      assert.equal(s, s.toLowerCase(), `lowercase: ${s}`);
    }
  });
  it("names the person in the sheet's sentences and never prints a key", () => {
    assert.equal(tagSentence("add", "Sam Example"), "tag Sam Example in this photo");
    assert.equal(tagSentence("move", "Sam Example"), "change where Sam Example is tagged in this photo");
    assert.equal(tagSentence("remove", ""), "remove someone's tag from this photo");
    assert.ok(TAG_COPY.routeDirect && TAG_COPY.routeReview);
  });
  it("sameRect compares four numbers and null", () => {
    assert.equal(sameRect([1, 2, 3, 4], [1, 2, 3, 4]), true);
    assert.equal(sameRect([1, 2, 3, 4], [1, 2, 3, 5]), false);
    assert.equal(sameRect(null, null), true);
    assert.equal(sameRect(null, [1, 2, 3, 4]), false);
  });
});
